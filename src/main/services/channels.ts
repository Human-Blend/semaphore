import { CHANNEL_NAME_MAX, normalizeChannelName } from '@shared/channelName'
import type { SysPayload, VerifiedEvent } from '@shared/types'
import type { ChannelState } from '../transport/session'
// Single source of truth (1.2 review fix): this used to be its own copy
// (`/^#+/`, 40 chars) that had drifted from Sidebar.tsx's (`/^#/`, no cap) —
// re-exported (unchanged call sites elsewhere in this file / channels.test.ts).
export { CHANNEL_NAME_MAX, normalizeChannelName }

// Channel rename/delete (1.2). Both ride the event log as `sys` events rather
// than a metadata rewrite: clients read `channel.json.e1` exactly once and
// cache it forever, so a rewritten file would reach nobody who is already in
// the team. Folding is last-writer-wins by event id (the stem sorts as HLC
// order), and the tombstone is sticky — a rename that lands after a delete
// updates the name of something nobody can see any more, never resurrects it.

/**
 * Fold one `sys` event from a channel log into its state. Returns whether
 * anything changed (the caller pushes `channels` when it did).
 */
export function foldChannelSys(state: ChannelState, event: VerifiedEvent): boolean {
  if (event.type !== 'sys' || !event.verified) return false
  const p = event.payload as SysPayload
  if (p.kind === 'channel-renamed') {
    const name = typeof p.data.name === 'string' ? normalizeChannelName(p.data.name) : ''
    if (!name) return false
    if (state.renameStem && event.id <= state.renameStem) return false // older writer loses
    state.renameStem = event.id
    state.renamedBy = event.author
    if (state.name === name) return false
    state.name = name
    return true
  }
  if (p.kind === 'channel-deleted') {
    // The home channel cannot be deleted, and that has to hold on the *reading*
    // side too: refusing it only in `deleteChannel` leaves the rule enforced by
    // whoever happens to be publishing. One client with a stale idea of which
    // channel is fixed — or one that simply writes the event by hand — would
    // otherwise empty the sidebar for the whole team, with nowhere to land.
    // (Teams predating the flag carry it nowhere: ChatService.foldSys applies
    // the same refusal to the fold-computed home channel.)
    if (state.meta.fixed) return false
    if (state.deletedAt) return false
    state.deletedAt = Number(event.id.slice(0, 13)) || Date.now()
    return true
  }
  return false
}

/**
 * The team's home channel: the one flagged `fixed` at creation (1.2 teams), or
 * — for teams created before the flag existed — the oldest channel, ties
 * broken by the lowest channelId so every client picks the same one. Deleted
 * channels are out of the running; a fixed channel can never be deleted, so
 * the fallback only ever moves on teams that never had a flag.
 */
export function fixedChannelId(channels: ChannelState[]): string | null {
  const alive = channels.filter((c) => !c.deletedAt)
  const flagged = alive.filter((c) => c.meta.fixed)
  const pool = flagged.length ? flagged : alive
  let best: ChannelState | null = null
  for (const c of pool) {
    if (
      !best ||
      c.meta.created < best.meta.created ||
      (c.meta.created === best.meta.created && c.channelId < best.channelId)
    ) {
      best = c
    }
  }
  return best?.channelId ?? null
}
