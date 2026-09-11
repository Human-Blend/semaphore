import type { ChannelView, GroupView } from '@shared/bridge'
import type { ConvId, VerifiedEvent } from '@shared/types'

// Pure reducer for "the conversation I'm looking at just disappeared" (1.2):
// a channel got deleted, a group got deleted, or the local device left/was
// removed from a group. Kept free of React/bridge/store so it is trivially
// testable (convVanish.test.ts) and callable from both the `channels` and
// `groups` push handlers in store/index.ts.

export interface VanishResult {
  /** Where to land: the fixed channel, else the first channel, else nowhere. */
  target: ConvId | null
  toastText: string
}

function lastSysEvent(events: VerifiedEvent[]) {
  // `events` is kept sorted ascending by id (= HLC order) everywhere it's
  // built in the store, so the last sys event is the most recent one. `grp`
  // events (group-invite/-rekey/-removed) travel over a DM log rather than
  // the group's own — see GrpPayload's comment — but read the same way here:
  // a kind string and an author.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.payload.t === 'sys' || ev.payload.t === 'grp') return { kind: ev.payload.kind, author: ev.author }
  }
  return null
}

/**
 * `group-removed` — the owner telling the removed device why its group just
 * vanished — travels over their DM, never the group's own log (the removal
 * event there is written under the new epoch key precisely so the removed
 * device cannot read it). So when the group being watched is what's active,
 * its own cached events never carry the reason; this scans every other
 * cached conv for a `group-removed` naming this exact group id. Exported for
 * its own test — the merge itself happens in store/index.ts's checkConvVanish,
 * which has access to every conv's event cache, not just the active one.
 */
export function findGroupRemovedEvent(allEvents: Record<string, VerifiedEvent[]>, groupId: string): VerifiedEvent | null {
  let best: VerifiedEvent | null = null
  for (const list of Object.values(allEvents)) {
    for (const ev of list) {
      if (ev.payload.t !== 'grp' || ev.payload.kind !== 'group-removed') continue
      if ((ev.payload.data as { groupId?: unknown }).groupId !== groupId) continue
      if (!best || ev.id > best.id) best = ev
    }
  }
  return best
}

export function resolveActiveConvVanish(params: {
  activeConv: ConvId | null
  /** Channel/group lists *after* the push that triggered this check. */
  channels: ChannelView[]
  groups: GroupView[]
  /** The lists just *before* that push, so a vanished conv's name is still known. */
  prevChannels: ChannelView[]
  prevGroups: GroupView[]
  /** Cached events for `activeConv`, if any were loaded. */
  events: VerifiedEvent[]
  selfDeviceId: string
  nameOf: (deviceId: string) => string
}): VanishResult | null {
  const { activeConv, channels, groups, prevChannels, prevGroups, events, selfDeviceId, nameOf } = params
  if (activeConv === null) return null
  if (channels.some((c) => c.conv === activeConv)) return null
  if (groups.some((g) => g.conv === activeConv)) return null

  const wasChannel = prevChannels.find((c) => c.conv === activeConv)
  const wasGroup = prevGroups.find((g) => g.conv === activeConv)
  // Never a conversation we actually knew about (e.g. a stale id) — nothing
  // vanished from under the user, so there's nothing to announce or move from.
  if (!wasChannel && !wasGroup) return null

  const fixed = channels.find((c) => c.fixed)
  const target = fixed ? fixed.conv : (channels[0]?.conv ?? null)
  const sys = lastSysEvent(events)
  const authorName = sys ? nameOf(sys.author) : null

  let toastText: string
  if (wasChannel) {
    toastText =
      sys?.kind === 'channel-deleted' && authorName
        ? `#${wasChannel.name} was deleted by ${authorName}`
        : `#${wasChannel.name} was deleted`
  } else {
    const name = wasGroup!.name
    if (sys?.kind === 'group-left' && sys.author === selfDeviceId) toastText = `You left 🔒 ${name}`
    else if (sys?.kind === 'group-removed') toastText = `You were removed from 🔒 ${name}`
    else if (sys?.kind === 'group-deleted' && authorName) toastText = `🔒 ${name} was deleted by ${authorName}`
    else toastText = `🔒 ${name} is no longer available`
  }
  return { target, toastText }
}
