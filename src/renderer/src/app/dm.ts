import { useMemo } from 'react'
import { create } from 'zustand'
import type { ConvId } from '@shared/types'
import type { GroupView } from '@shared/bridge'
import { useStore } from '@/store'
import { toast } from './toasts'

// The frozen store doesn't keep a conv → DM-peer mapping, so the shell keeps
// its own tiny one: filled whenever a DM is opened, consulted by the header,
// right rail, and empty states.

export const useDmMap = create<{
  peers: Record<string, string> // conv -> peerDeviceId
  remember(conv: ConvId, peerDeviceId: string): void
}>((set) => ({
  peers: {},
  remember(conv, peerDeviceId) {
    set((s) => (s.peers[conv] === peerDeviceId ? s : { peers: { ...s.peers, [conv]: peerDeviceId } }))
  },
}))

/**
 * conv -> GroupView lookup for private groups (1.2). Unlike useDmMap this
 * needs no "remember" step: a GroupView already carries everything (name,
 * owner, members, role) and arrives fully formed via the `groups` push, the
 * same way ChannelView does — so it's just a memoized index over the store.
 */
export function useGroupMap(): Record<string, GroupView> {
  const groups = useStore((s) => s.groups)
  return useMemo(() => {
    const map: Record<string, GroupView> = {}
    for (const g of groups) map[g.conv] = g
    return map
  }, [groups])
}

/** Open (or create) the DM with a peer and make it the active conversation. */
export async function openDm(peerDeviceId: string): Promise<void> {
  try {
    const dm = await window.bridge.chat.dmFor(peerDeviceId)
    if (!dm) {
      toast('Could not open that conversation', 'danger')
      return
    }
    useDmMap.getState().remember(dm.conv, dm.peerDeviceId)
    useStore.getState().setActiveConv(dm.conv)
  } catch (err) {
    toast(`Could not open DM — ${err instanceof Error ? err.message : String(err)}`, 'danger')
  }
}
