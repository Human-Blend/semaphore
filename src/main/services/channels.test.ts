import { describe, expect, it } from 'vitest'
import type { ConvId, VerifiedEvent } from '@shared/types'
import type { ChannelState } from '../transport/session'
import { CHANNEL_NAME_MAX, fixedChannelId, foldChannelSys, normalizeChannelName } from './channels'

// Renaming and deleting a channel are sys events in its own log, folded
// last-writer-wins by event id. The rules that matter: the newest rename wins
// whatever order the events arrive in, a tombstone is final, and every client
// picks the same home channel — including teams created before the `fixed`
// flag existed, where the oldest channel is it.

const CONV: ConvId = 'chan:deadbeef'

function channel(channelId: string, name: string, created: number, fixed?: true): ChannelState {
  return {
    channelId,
    token: `TOKEN${channelId}`,
    meta: {
      type: 'channel',
      channelId,
      name,
      topic: '',
      creator: 'a'.repeat(32),
      created,
      ...(fixed ? { fixed: true as const } : {}),
    },
    key: Buffer.alloc(32),
    name,
  }
}

function sysEvent(
  id: string,
  kind: 'channel-renamed' | 'channel-deleted',
  data: Record<string, unknown>,
  opts: { author?: string; verified?: boolean } = {},
): VerifiedEvent {
  return {
    id,
    type: 'sys',
    payload: { t: 'sys', conv: CONV, kind, data },
    author: opts.author ?? 'b'.repeat(32),
    verified: opts.verified ?? true,
    receivedAt: 0,
  }
}

describe('channel name normalization', () => {
  it('matches what the create field produces', () => {
    expect(normalizeChannelName('  Release Planning  ')).toBe('release-planning')
    expect(normalizeChannelName('#general')).toBe('general')
    expect(normalizeChannelName('a\t\tb')).toBe('a-b')
  })

  it('rejects an empty name and caps a long one', () => {
    expect(normalizeChannelName('   ')).toBe('')
    expect(normalizeChannelName('#')).toBe('')
    expect(normalizeChannelName('x'.repeat(80))).toHaveLength(CHANNEL_NAME_MAX)
  })
})

describe('folding channel sys events', () => {
  it('takes the newest rename whatever order the events arrive in', () => {
    const ch = channel('01', 'general', 1000)
    expect(foldChannelSys(ch, sysEvent('1700000000002-0001-aaaaaaaa', 'channel-renamed', { name: 'later' }))).toBe(true)
    // An older rename arriving afterwards (a peer caught up late) loses.
    expect(foldChannelSys(ch, sysEvent('1700000000001-0001-bbbbbbbb', 'channel-renamed', { name: 'earlier' }))).toBe(
      false,
    )
    expect(ch.name).toBe('later')
  })

  it('normalizes the renamed-to name and ignores an empty one', () => {
    const ch = channel('01', 'general', 1000)
    foldChannelSys(ch, sysEvent('1700000000001-0001-aaaaaaaa', 'channel-renamed', { name: '  Team Sync ' }))
    expect(ch.name).toBe('team-sync')
    foldChannelSys(ch, sysEvent('1700000000002-0001-aaaaaaaa', 'channel-renamed', { name: '   ' }))
    expect(ch.name).toBe('team-sync')
  })

  it('never lets a rename resurrect a deleted channel', () => {
    const ch = channel('01', 'general', 1000)
    foldChannelSys(ch, sysEvent('1700000000005-0001-aaaaaaaa', 'channel-deleted', {}))
    expect(ch.deletedAt).toBe(1700000000005)
    // A rename with a *higher* id still does not bring it back.
    foldChannelSys(ch, sysEvent('1700000000009-0001-bbbbbbbb', 'channel-renamed', { name: 'zombie' }))
    expect(ch.deletedAt).toBe(1700000000005)
    expect(fixedChannelId([ch])).toBeNull() // deleted channels are out of every list
  })

  it('refuses a tombstone for the flagged home channel, however it was published', () => {
    // The rule "the home channel cannot be deleted" was writer-side only: a
    // client with a stale idea of which channel is fixed, or one simply writing
    // the event by hand, could empty every sidebar in the team. Readers refuse
    // it too, and a rename of the same channel still works.
    const home = channel('01', 'general', 1000, true)
    expect(foldChannelSys(home, sysEvent('1700000000005-0001-aaaaaaaa', 'channel-deleted', {}))).toBe(false)
    expect(home.deletedAt).toBeUndefined()
    expect(foldChannelSys(home, sysEvent('1700000000006-0001-aaaaaaaa', 'channel-renamed', { name: 'lobby' }))).toBe(true)
    expect(home.name).toBe('lobby')
    expect(home.deletedAt).toBeUndefined()
  })

  it('ignores unverified events and unrelated sys kinds', () => {
    const ch = channel('01', 'general', 1000)
    expect(
      foldChannelSys(ch, sysEvent('1700000000001-0001-aaaaaaaa', 'channel-renamed', { name: 'forged' }, { verified: false })),
    ).toBe(false)
    expect(
      foldChannelSys(ch, {
        id: '1700000000002-0001-aaaaaaaa',
        type: 'msg',
        payload: { t: 'sys', conv: CONV, kind: 'channel-deleted', data: {} },
        author: 'c'.repeat(32),
        verified: true,
        receivedAt: 0,
      }),
    ).toBe(false)
    expect(ch.name).toBe('general')
    expect(ch.deletedAt).toBeUndefined()
  })
})

describe('the fixed (home) channel', () => {
  it('is the flagged one, even when a younger channel is flagged', () => {
    const channels = [channel('01', 'old', 1000), channel('02', 'home', 5000, true)]
    expect(fixedChannelId(channels)).toBe('02')
  })

  it('falls back to the oldest channel when no flag exists (pre-1.2 teams)', () => {
    const channels = [channel('02', 'random', 5000), channel('01', 'general', 1000)]
    expect(fixedChannelId(channels)).toBe('01')
  })

  it('breaks a created-at tie by the lowest channelId, so every client agrees', () => {
    const channels = [channel('ff', 'b', 1000), channel('0a', 'a', 1000)]
    expect(fixedChannelId(channels)).toBe('0a')
  })

  it('picks the oldest flagged channel when two carry the flag', () => {
    const channels = [channel('02', 'second', 9000, true), channel('01', 'first', 2000, true)]
    expect(fixedChannelId(channels)).toBe('01')
  })

  it('skips deleted channels', () => {
    const oldest = channel('01', 'gone', 1000)
    oldest.deletedAt = 2000
    expect(fixedChannelId([oldest, channel('02', 'alive', 5000)])).toBe('02')
  })
})
