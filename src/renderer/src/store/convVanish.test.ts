import { describe, expect, it } from 'vitest'
import type { ChannelView, GroupView } from '@shared/bridge'
import type { ConvId, SysPayload, VerifiedEvent } from '@shared/types'
import { findGroupRemovedEvent, resolveActiveConvVanish } from './convVanish'

function chan(conv: string, name: string, fixed = false): ChannelView {
  return { conv: conv as ConvId, channelId: conv.slice(5), name, topic: '', fixed }
}

function grp(conv: string, name: string, owner = 'owner01'): GroupView {
  return { conv: conv as ConvId, groupId: conv.slice(4), name, owner, members: [owner, 'me000001'], epoch: 1, role: 'member' }
}

function sysEvent(conv: string, kind: SysPayload['kind'], author: string, id = '0000000000001-0000-aaaaaaaa'): VerifiedEvent {
  return { id, type: 'sys', payload: { t: 'sys', conv: conv as ConvId, kind, data: {} }, author, verified: true, receivedAt: 0 }
}

/** A `group-removed` notice as it actually travels — over a DM log, `t: 'grp'` — not the group's own `sys` log. */
function grpRemovedEvent(dmConv: string, groupId: string, author: string, id = '0000000000001-0000-aaaaaaaa'): VerifiedEvent {
  return {
    id,
    type: 'grp',
    payload: { t: 'grp', conv: dmConv as ConvId, kind: 'group-removed', data: { groupId, epoch: 2 } },
    author,
    verified: true,
    receivedAt: 0,
  }
}

const nameOf = (d: string) => (d === 'owner01' ? 'Owner' : d === 'me000001' ? 'Me' : d)

describe('resolveActiveConvVanish', () => {
  it('does nothing when there is no active conversation', () => {
    expect(
      resolveActiveConvVanish({
        activeConv: null,
        channels: [],
        groups: [],
        prevChannels: [],
        prevGroups: [],
        events: [],
        selfDeviceId: '',
        nameOf,
      }),
    ).toBeNull()
  })

  it('does nothing when the active channel is still present', () => {
    const channels = [chan('chan:a', 'general', true)]
    expect(
      resolveActiveConvVanish({
        activeConv: 'chan:a',
        channels,
        groups: [],
        prevChannels: channels,
        prevGroups: [],
        events: [],
        selfDeviceId: 'me000001',
        nameOf,
      }),
    ).toBeNull()
  })

  it('does nothing when the active group is still present', () => {
    const groups = [grp('grp:x', 'Firefly')]
    expect(
      resolveActiveConvVanish({
        activeConv: 'grp:x',
        channels: [],
        groups,
        prevChannels: [],
        prevGroups: groups,
        events: [],
        selfDeviceId: 'me000001',
        nameOf,
      }),
    ).toBeNull()
  })

  it('ignores a conv that was never known locally — nothing to announce or move from', () => {
    const channels = [chan('chan:home', 'general', true)]
    expect(
      resolveActiveConvVanish({
        activeConv: 'grp:ghost',
        channels,
        groups: [],
        prevChannels: channels,
        prevGroups: [],
        events: [],
        selfDeviceId: 'me000001',
        nameOf,
      }),
    ).toBeNull()
  })

  it('lands on the fixed channel and names the deleter when a channel is deleted', () => {
    const prevChannels = [chan('chan:home', 'general', true), chan('chan:proj', 'project')]
    const channels = [chan('chan:home', 'general', true)]
    const result = resolveActiveConvVanish({
      activeConv: 'chan:proj',
      channels,
      groups: [],
      prevChannels,
      prevGroups: [],
      events: [sysEvent('chan:proj', 'channel-deleted', 'owner01')],
      selfDeviceId: 'me000001',
      nameOf,
    })
    expect(result).toEqual({ target: 'chan:home', toastText: '#project was deleted by Owner' })
  })

  it('falls back to the first channel, and a generic message, when nothing is flagged fixed or the tombstone is missing', () => {
    const prevChannels = [chan('chan:a', 'a'), chan('chan:b', 'b')]
    const channels = [chan('chan:a', 'a')]
    const result = resolveActiveConvVanish({
      activeConv: 'chan:b',
      channels,
      groups: [],
      prevChannels,
      prevGroups: [],
      events: [],
      selfDeviceId: 'me000001',
      nameOf,
    })
    expect(result).toEqual({ target: 'chan:a', toastText: '#b was deleted' })
  })

  it('falls back to nowhere when the channel list is empty too', () => {
    const prevChannels = [chan('chan:only', 'only')]
    const result = resolveActiveConvVanish({
      activeConv: 'chan:only',
      channels: [],
      groups: [],
      prevChannels,
      prevGroups: [],
      events: [],
      selfDeviceId: 'me000001',
      nameOf,
    })
    expect(result).toEqual({ target: null, toastText: '#only was deleted' })
  })

  it('reports "you left" when the local device is the one that left the group', () => {
    const prevGroups = [grp('grp:x', 'Firefly')]
    const channels = [chan('chan:home', 'general', true)]
    const result = resolveActiveConvVanish({
      activeConv: 'grp:x',
      channels,
      groups: [],
      prevChannels: channels,
      prevGroups,
      events: [sysEvent('grp:x', 'group-left', 'me000001')],
      selfDeviceId: 'me000001',
      nameOf,
    })
    expect(result).toEqual({ target: 'chan:home', toastText: 'You left 🔒 Firefly' })
  })

  it('reports removal when the owner removed the local device', () => {
    // `group-removed` travels as a `grp` event over the owner's DM, never as
    // a `sys` event in the group's own log (the removed device can't decrypt
    // that one — it's written under the new epoch key) — checkConvVanish
    // merges the DM-cached notice in before calling this, which is what
    // `events` here simulates.
    const prevGroups = [grp('grp:x', 'Firefly')]
    const channels = [chan('chan:home', 'general', true)]
    const result = resolveActiveConvVanish({
      activeConv: 'grp:x',
      channels,
      groups: [],
      prevChannels: channels,
      prevGroups,
      events: [grpRemovedEvent('dm:owner-me', 'x', 'owner01')],
      selfDeviceId: 'me000001',
      nameOf,
    })
    expect(result).toEqual({ target: 'chan:home', toastText: 'You were removed from 🔒 Firefly' })
  })

  it('falls back to the generic message when only the unreadable group-log tombstone is cached', () => {
    // Regression for the pre-fix bug: `group-member-removed` sits in the
    // group's own log under the new epoch key, which the removed device
    // never gets — so it must not be read as "you were removed" here.
    const prevGroups = [grp('grp:x', 'Firefly')]
    const channels = [chan('chan:home', 'general', true)]
    const result = resolveActiveConvVanish({
      activeConv: 'grp:x',
      channels,
      groups: [],
      prevChannels: channels,
      prevGroups,
      events: [sysEvent('grp:x', 'group-member-removed', 'owner01')],
      selfDeviceId: 'me000001',
      nameOf,
    })
    expect(result).toEqual({ target: 'chan:home', toastText: '🔒 Firefly is no longer available' })
  })

  it('names the owner when the whole group was deleted', () => {
    const prevGroups = [grp('grp:x', 'Firefly')]
    const channels = [chan('chan:home', 'general', true)]
    const result = resolveActiveConvVanish({
      activeConv: 'grp:x',
      channels,
      groups: [],
      prevChannels: channels,
      prevGroups,
      events: [sysEvent('grp:x', 'group-deleted', 'owner01')],
      selfDeviceId: 'me000001',
      nameOf,
    })
    expect(result).toEqual({ target: 'chan:home', toastText: '🔒 Firefly was deleted by Owner' })
  })

  it('falls back to a generic message when a group vanished with no visible tombstone', () => {
    const prevGroups = [grp('grp:x', 'Firefly')]
    const channels = [chan('chan:home', 'general', true)]
    const result = resolveActiveConvVanish({
      activeConv: 'grp:x',
      channels,
      groups: [],
      prevChannels: channels,
      prevGroups,
      events: [],
      selfDeviceId: 'me000001',
      nameOf,
    })
    expect(result).toEqual({ target: 'chan:home', toastText: '🔒 Firefly is no longer available' })
  })
})

describe('findGroupRemovedEvent', () => {
  it('finds a group-removed notice cached under a different conv (its DM)', () => {
    const ev = grpRemovedEvent('dm:owner-me', 'x', 'owner01')
    const allEvents = { 'grp:x': [], 'dm:owner-me': [ev], 'chan:home': [sysEvent('chan:home', 'channel-created', 'owner01')] }
    expect(findGroupRemovedEvent(allEvents, 'x')).toEqual(ev)
  })

  it('ignores a notice for a different group id', () => {
    const allEvents = { 'dm:owner-me': [grpRemovedEvent('dm:owner-me', 'y', 'owner01')] }
    expect(findGroupRemovedEvent(allEvents, 'x')).toBeNull()
  })

  it('ignores group-invite/-rekey notices and plain sys events', () => {
    const invite: VerifiedEvent = {
      id: '0000000000001-0000-aaaaaaaa',
      type: 'grp',
      payload: { t: 'grp', conv: 'dm:owner-me' as ConvId, kind: 'group-invite', data: { groupId: 'x', epoch: 1 } },
      author: 'owner01',
      verified: true,
      receivedAt: 0,
    }
    const allEvents = { 'dm:owner-me': [invite, sysEvent('dm:owner-me', 'group-deleted', 'owner01')] }
    expect(findGroupRemovedEvent(allEvents, 'x')).toBeNull()
  })

  it('picks the most recent when more than one is cached', () => {
    const older = grpRemovedEvent('dm:owner-me', 'x', 'owner01', '0000000000001-0000-aaaaaaaa')
    const newer = grpRemovedEvent('dm:owner-me', 'x', 'owner01', '0000000000002-0000-bbbbbbbb')
    expect(findGroupRemovedEvent({ 'dm:owner-me': [older, newer] }, 'x')).toEqual(newer)
  })

  it('returns null with nothing cached anywhere', () => {
    expect(findGroupRemovedEvent({}, 'x')).toBeNull()
  })
})
