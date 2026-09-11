import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDraft, draftSlotOf, readDraft, writeDraft } from './drafts'

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
