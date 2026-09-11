import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_PEER_NAME,
  dismissedFor,
  forgetPeerDismissal,
  laterKey,
  peerSentence,
  rememberLater,
  shortPeerName,
} from './updateBannerState'

// The banner has two sources and they are not interchangeable: the signed
// manifest can hand you the zip, a peer beacon is a sentence anyone with write
// access to the share can produce. The dismissal bookkeeping has to keep them
// apart, or "remind me later" about the rumour buries the real release.

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string): string | null {
    return this.m.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v)
  }
  removeItem(k: string): void {
    this.m.delete(k)
  }
  clear(): void {
    this.m.clear()
  }
  key(): string | null {
    return null
  }
  get length(): number {
    return this.m.size
  }
}

const g = globalThis as { localStorage?: unknown }

beforeEach(() => {
  g.localStorage = new MemStorage() as unknown as Storage
})

afterEach(() => {
  delete g.localStorage
})

describe('update banner dismissals', () => {
  it('keys on the source as well as the version', () => {
    expect(laterKey('1.2.0', 'peer')).not.toBe(laterKey('1.2.0', 'manifest'))
  })

  it('"remind me later" on the peer banner leaves the real manifest banner free to speak', () => {
    rememberLater('1.2.0', 'peer')
    expect(dismissedFor('1.2.0', 'peer')).toBe(true)
    // The regression: this was `true`, so the one banner that can actually copy
    // the zip stayed hidden for that version forever.
    expect(dismissedFor('1.2.0', 'manifest')).toBe(false)
  })

  it('a manifest banner clears the peer dismissal for the same version', () => {
    rememberLater('1.2.0', 'peer')
    forgetPeerDismissal('1.2.0')
    expect(dismissedFor('1.2.0', 'peer')).toBe(false)
    expect(dismissedFor('1.2.0', 'manifest')).toBe(false)
  })

  it('a dismissal never carries to another version', () => {
    rememberLater('1.2.0', 'manifest')
    expect(dismissedFor('1.2.1', 'manifest')).toBe(false)
    expect(dismissedFor('1.2.0', 'manifest')).toBe(true)
  })

  it('survives storage being unavailable', () => {
    delete g.localStorage
    expect(() => rememberLater('1.2.0', 'peer')).not.toThrow()
    expect(() => forgetPeerDismissal('1.2.0')).not.toThrow()
    expect(dismissedFor('1.2.0', 'peer')).toBe(false)
  })
})

describe('peer banner wording', () => {
  it('reports a claim and its claimant, never that an update is available', () => {
    const line = peerSentence('Ana', '1.2.0')
    expect(line).toBe("Ana says they're on Chat 1.2.0 — no signed build in the apps folder yet.")
    expect(line).not.toMatch(/available/i)
  })

  it('clamps a display name off the share instead of letting it run the banner', () => {
    const long = 'A'.repeat(200)
    const name = shortPeerName(long)
    expect(name).toHaveLength(MAX_PEER_NAME)
    expect(name.endsWith('…')).toBe(true)
    expect(peerSentence(long, '1.2.0').length).toBeLessThan(120)
  })

  it('collapses whitespace and falls back to a generic noun', () => {
    expect(shortPeerName('  Ana   Lee \n')).toBe('Ana Lee')
    expect(shortPeerName(undefined)).toBe('A teammate')
    expect(shortPeerName('   ')).toBe('A teammate')
    expect(peerSentence('', '1.2.0')).toBe("A teammate says they're on Chat 1.2.0 — no signed build in the apps folder yet.")
  })
})
