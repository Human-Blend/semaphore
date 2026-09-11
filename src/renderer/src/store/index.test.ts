import { describe, expect, it, vi } from 'vitest'
import type { ChannelView, GroupView, PushMessage } from '@shared/bridge'
import type { ConvId, SysPayload, VerifiedEvent } from '@shared/types'
import { TEAM_CONV } from '@shared/constants'

// The store talks to the preload bridge only through `window.bridge`, so the
// whole push path is testable in the node env with a stub bridge.

interface Harness {
  push(msg: PushMessage): void
  badges: number[]
  store: typeof import('./index').useStore
}

async function harness(): Promise<Harness> {
  const badges: number[] = []
  let handler: ((msg: PushMessage) => void) | null = null
  const bridge = {
    onPush: (fn: (msg: PushMessage) => void) => {
      handler = fn
    },
    app: {
      getBoot: async () => ({ mode: 'onboarding' as const }),
      setBadge: async (count: number) => {
        badges.push(count)
      },
    },
    settings: { get: async () => null },
    chat: { events: async () => [], cursors: async () => ({}) },
  }
  ;(globalThis as unknown as { window: unknown }).window = { bridge }
  const { useStore } = await import('./index')
  await useStore.getState().init()
  return {
    push: (msg) => handler?.(msg),
    badges,
    store: useStore,
  }
}

// --- "channels"/"groups" push wiring (1.2 — the active-conv-vanished toast) ---
// A fuller harness: boot 'ready' (checkConvVanish needs a self device id) with
// controllable channels/groups/events, so a push can be dispatched against a
// specific seeded state instead of just the boot/prs-flag plumbing above.

function chan(conv: string, name: string, fixed = false): ChannelView {
  return { conv: conv as ConvId, channelId: conv.slice(5), name, topic: '', fixed }
}

function grp(conv: string, name: string, owner = 'owner01'): GroupView {
  return { conv: conv as ConvId, groupId: conv.slice(4), name, owner, members: [owner, 'me000001'], epoch: 1, role: 'member' }
}

function sysEvent(conv: string, kind: SysPayload['kind'], author: string, id = '0000000000001-0000-aaaaaaaa'): VerifiedEvent {
  return { id, type: 'sys', payload: { t: 'sys', conv: conv as ConvId, kind, data: {} }, author, verified: true, receivedAt: 0 }
}

interface ReadyHarness {
  push(msg: PushMessage): void
  store: typeof import('./index').useStore
}

async function readyHarness(opts: { channels: ChannelView[]; groups?: GroupView[] }): Promise<ReadyHarness> {
  let handler: ((msg: PushMessage) => void) | null = null
  const self = {
    deviceId: 'me000001',
    displayName: 'Me',
    hostname: 'my-mac',
    fingerprint: 'AAAA-0000',
    teamName: 'Team',
    sharePath: '/share',
    platform: 'darwin' as const,
  }
  const bridge = {
    onPush: (fn: (msg: PushMessage) => void) => {
      handler = fn
    },
    app: { getBoot: async () => ({ mode: 'ready' as const, self }), setBadge: async () => {} },
    settings: { get: async () => null },
    chat: {
      channels: async () => opts.channels,
      events: async () => [],
      cursors: async () => ({}),
      myReads: async () => ({}),
    },
    presence: { list: async () => [] },
    groups: { list: async () => opts.groups ?? [] },
    prs: {
      status: async () => {
        throw new Error('not-ready')
      },
      list: async () => [],
    },
  }
  ;(globalThis as unknown as { window: unknown }).window = { bridge, setTimeout: globalThis.setTimeout.bind(globalThis) }
  const { useStore } = await import('./index')
  await useStore.getState().init()
  return { push: (msg) => handler?.(msg), store: useStore }
}

describe('store: channels/groups push lands the vanished active conv on the fixed channel', () => {
  it('moves off a deleted channel', async () => {
    const home = chan('chan:home', 'general', true)
    const proj = chan('chan:proj', 'project')
    const h = await readyHarness({ channels: [home, proj] })
    h.store.getState().setActiveConv('chan:proj')
    await vi.waitFor(() => {
      if (!h.store.getState().eventsLoaded['chan:proj']) throw new Error('events not loaded yet')
    })
    h.store.setState({
      events: { ...h.store.getState().events, 'chan:proj': [sysEvent('chan:proj', 'channel-deleted', 'owner01')] },
    })

    h.push({ kind: 'channels', channels: [home] })

    expect(h.store.getState().activeConv).toBe('chan:home')
  })

  it('moves off a deleted group, same as a deleted channel', async () => {
    const home = chan('chan:home', 'general', true)
    const g = grp('grp:x', 'Firefly')
    const h = await readyHarness({ channels: [home], groups: [g] })
    h.store.getState().setActiveConv('grp:x')
    await vi.waitFor(() => {
      if (!h.store.getState().eventsLoaded['grp:x']) throw new Error('events not loaded yet')
    })
    h.store.setState({
      events: { ...h.store.getState().events, 'grp:x': [sysEvent('grp:x', 'group-deleted', 'owner01')] },
    })

    h.push({ kind: 'groups', groups: [] })

    expect(h.store.getState().activeConv).toBe('chan:home')
  })

  it('moves off a group removed from under the user, with the reason cached only in the owner DM', async () => {
    // `group-removed` travels as a `grp` event over the owner's DM, never in
    // the group's own log — checkConvVanish has to find it in a different
    // conv's cache than the one that's active.
    const home = chan('chan:home', 'general', true)
    const g = grp('grp:x', 'Firefly')
    const h = await readyHarness({ channels: [home], groups: [g] })
    h.store.getState().setActiveConv('grp:x')
    await vi.waitFor(() => {
      if (!h.store.getState().eventsLoaded['grp:x']) throw new Error('events not loaded yet')
    })
    h.store.setState({
      events: {
        ...h.store.getState().events,
        'dm:owner-me': [
          {
            id: '0000000000001-0000-aaaaaaaa',
            type: 'grp',
            payload: { t: 'grp', conv: 'dm:owner-me' as ConvId, kind: 'group-removed', data: { groupId: 'x', epoch: 2 } },
            author: 'owner01',
            verified: true,
            receivedAt: 0,
          },
        ],
      },
    })

    h.push({ kind: 'groups', groups: [] })

    expect(h.store.getState().activeConv).toBe('chan:home')
  })

  it('leaves the active conv alone when the push still contains it', async () => {
    const home = chan('chan:home', 'general', true)
    const proj = chan('chan:proj', 'project')
    const h = await readyHarness({ channels: [home, proj] })
    h.store.getState().setActiveConv('chan:proj')

    h.push({ kind: 'channels', channels: [home, proj] })

    expect(h.store.getState().activeConv).toBe('chan:proj')
  })
})

describe('store: boot push', () => {
  it('clears the dock badge and team state when the team folder is disconnected', async () => {
    const h = await harness()
    h.store.setState({ prs: [{ key: 'r/1' }] as never, prsStatus: { unseen: 3 } as never })
    h.badges.length = 0

    h.push({ kind: 'boot', boot: { mode: 'onboarding' } } as PushMessage)

    // PrAlert unmounts on this very render, so the store must send the 0 itself.
    expect(h.badges).toEqual([0])
    expect(h.store.getState().prs).toEqual([])
    expect(h.store.getState().prsStatus).toBeNull()
  })
})

describe('store: prs prefs flag', () => {
  it('drops the prefs flag when the active conversation leaves the PR group', async () => {
    const h = await harness()

    h.store.getState().setPrsPrefsOpen(true)
    expect(h.store.getState().activeConv).toBe(TEAM_CONV.prs)
    expect(h.store.getState().prsPrefsOpen).toBe(true)

    // The modal unmounts with PrsPane, so the flag must not survive the move.
    h.store.getState().setActiveConv('chan:general')
    expect(h.store.getState().prsPrefsOpen).toBe(false)

    // Coming back shows the list, not the settings dialog.
    h.store.getState().setActiveConv(TEAM_CONV.prs)
    expect(h.store.getState().prsPrefsOpen).toBe(false)
  })

  it('keeps the flag when navigating to the PR group itself', async () => {
    const h = await harness()

    h.store.getState().setPrsPrefsOpen(true)
    h.store.getState().setActiveConv(TEAM_CONV.prs)
    expect(h.store.getState().prsPrefsOpen).toBe(true)
  })
})
