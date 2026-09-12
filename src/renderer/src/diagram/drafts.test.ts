import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDraft, draftRestorable, draftSlotOf, pruneLiveDrafts, readDraft, writeDraft } from './drafts'

// localStorage is a browser API and vitest runs in node, so the module's global
// is stubbed with the same shape. What is being pinned is the KEYING: a
// conversation is not a slot, and two pieces of unsent work in the same channel
// must not land on top of each other.

class FakeStorage {
  map = new Map<string, string>()
  failWrites = false
  getItem(k: string): string | null {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError')
    this.map.set(k, v)
  }
  removeItem(k: string): void {
    this.map.delete(k)
  }
  // Enumeration, as the real Storage has it — `pruneLiveDrafts` walks the keys.
  get length(): number {
    return this.map.size
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null
  }
}

let store: FakeStorage

beforeEach(() => {
  store = new FakeStorage()
  vi.stubGlobal('localStorage', store)
})

const conv = 'chan:abc'

describe('draftSlotOf', () => {
  it('separates a new diagram from a copy of a specific message', () => {
    expect(draftSlotOf({})).toBe('new')
    expect(draftSlotOf({ replyTo: undefined })).toBe('new')
    expect(draftSlotOf({ replyTo: 'evt-1' })).toBe('evt-1')
  })

  // 1.3: a live board used to land on the conversation's 'new' slot, which is
  // where the person's unsent private drawing lives. Joining a board then
  // opened that drawing and published it to everyone in the conversation.
  it('gives a live board its own slot, per session for a join', () => {
    expect(draftSlotOf({ live: { kind: 'join', sessionId: 'ses1' } })).toBe('live:ses1')
    expect(draftSlotOf({ live: { kind: 'join', sessionId: 'ses2' } })).toBe('live:ses2')
    expect(draftSlotOf({ live: { kind: 'start', boardId: 'ev1' } })).toBe('live:new')
    // …and never the slot an unsent diagram is kept in.
    expect(draftSlotOf({ live: { kind: 'start' }, replyTo: 'evt-1' })).not.toBe('evt-1')
    expect(draftSlotOf({ live: { kind: 'join', sessionId: 'ses1' } })).not.toBe('new')
  })
})

describe('draftRestorable', () => {
  it('restores an ordinary slot and never a live board', () => {
    expect(draftRestorable({})).toBe(true)
    expect(draftRestorable({ replyTo: 'evt-1' })).toBe(true)
    // A join's scene is the session's; a start's is the diagram that was
    // clicked. Either one coming out of localStorage is the wrong scene.
    expect(draftRestorable({ live: { kind: 'join', sessionId: 'ses1' } })).toBe(false)
    expect(draftRestorable({ live: { kind: 'start', boardId: 'ev1' } })).toBe(false)
  })
})

describe('live drafts do not pile up', () => {
  it('keeps one live draft per conversation and leaves the ordinary slots alone', () => {
    writeDraft(conv, 'new', { title: 'mine', scene: '{"mine":1}' })
    writeDraft(conv, 'evt-1', { title: 'copy', scene: '{"copy":1}' })
    writeDraft(conv, 'live:ses1', { title: 'board one', scene: '{"one":1}' })
    writeDraft(conv, 'live:ses2', { title: 'board two', scene: '{"two":1}' })

    // The newest live save swept the session before it — a session id is new
    // every time, so these would otherwise accumulate until the quota went.
    expect(readDraft(conv, 'live:ses1')).toBeNull()
    expect(readDraft(conv, 'live:ses2')?.title).toBe('board two')
    expect(readDraft(conv, 'new')?.title).toBe('mine')
    expect(readDraft(conv, 'evt-1')?.title).toBe('copy')
  })

  it('does not reach into another conversation', () => {
    writeDraft('chan:other', 'live:ses1', { title: 'theirs', scene: '{"t":1}' })
    writeDraft(conv, 'live:ses2', { title: 'mine', scene: '{"m":1}' })
    expect(readDraft('chan:other', 'live:ses1')?.title).toBe('theirs')
  })

  it('survives a storage that cannot be enumerated', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      get length(): number {
        throw new Error('nope')
      },
      key: () => null,
    })
    expect(() => pruneLiveDrafts(conv, 'live:ses1')).not.toThrow()
  })
})

describe('drafts are per slot', () => {
  it('does not let "edit a copy" overwrite the new-diagram draft', () => {
    writeDraft(conv, 'new', { title: 'Sprint plan', scene: '{"elements":[1]}' })
    writeDraft(conv, 'evt-1', { title: 'Ana’s diagram (copy)', scene: '{"elements":[2]}' })

    expect(readDraft(conv, 'new')?.scene).toBe('{"elements":[1]}')
    expect(readDraft(conv, 'evt-1')?.scene).toBe('{"elements":[2]}')
  })

  it('keeps conversations apart too', () => {
    writeDraft(conv, 'new', { title: 'a', scene: '{"a":1}' })
    writeDraft('chan:other', 'new', { title: 'b', scene: '{"b":1}' })
    expect(readDraft(conv, 'new')?.title).toBe('a')
    expect(readDraft('chan:other', 'new')?.title).toBe('b')
  })

  it('clears only the slot it was asked to clear', () => {
    writeDraft(conv, 'new', { title: 'a', scene: '{"a":1}' })
    writeDraft(conv, 'evt-1', { title: 'b', scene: '{"b":1}' })
    clearDraft(conv, 'evt-1')
    expect(readDraft(conv, 'evt-1')).toBeNull()
    expect(readDraft(conv, 'new')).not.toBeNull()
  })

  it('round-trips title, scene and a timestamp', () => {
    expect(writeDraft(conv, 'new', { title: 'Sprint plan', scene: '{"x":1}' })).toBe(true)
    const d = readDraft(conv, 'new')
    expect(d).toMatchObject({ title: 'Sprint plan', scene: '{"x":1}' })
    expect(d!.savedAt).toBeGreaterThan(0)
  })
})

describe('writeDraft reports whether the work was actually kept', () => {
  it('is false for a scene too large to store — and stores nothing', () => {
    expect(writeDraft(conv, 'new', { title: 't', scene: 'x'.repeat(1_500_001) })).toBe(false)
    expect(readDraft(conv, 'new')).toBeNull()
  })

  it('is false when the store itself refuses (quota, private mode)', () => {
    store.failWrites = true
    expect(writeDraft(conv, 'new', { title: 't', scene: '{"x":1}' })).toBe(false)
  })

  it('is true at the size limit', () => {
    expect(writeDraft(conv, 'new', { title: 't', scene: 'x'.repeat(1_500_000) })).toBe(true)
  })
})

describe('reading junk', () => {
  it('treats an unparseable or sceneless entry as no draft', () => {
    store.map.set('chat.diagram.draft.chan:abc|new', 'not json')
    expect(readDraft(conv, 'new')).toBeNull()
    store.map.set('chat.diagram.draft.chan:abc|new', JSON.stringify({ title: 't' }))
    expect(readDraft(conv, 'new')).toBeNull()
    store.map.set('chat.diagram.draft.chan:abc|new', JSON.stringify({ scene: '' }))
    expect(readDraft(conv, 'new')).toBeNull()
  })

  it('survives a storage that throws on read', () => {
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('nope')
      },
      setItem() {},
      removeItem() {
        throw new Error('nope')
      },
    })
    expect(readDraft(conv, 'new')).toBeNull()
    expect(() => clearDraft(conv, 'new')).not.toThrow()
  })
})
