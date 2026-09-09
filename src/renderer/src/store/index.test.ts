import { describe, expect, it } from 'vitest'
import type { PushMessage } from '@shared/bridge'
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
