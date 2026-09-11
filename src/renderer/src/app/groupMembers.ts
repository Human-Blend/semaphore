import type { ConvId, PresenceView } from '@shared/types'

// Pure filtering/ordering helpers shared by GroupDialog (who can be added)
// and RightRail (who is currently in the group) — 1.2 private groups. Kept
// dependency-free so they're trivially unit-testable (groupMembers.test.ts).

/**
 * People eligible to be added to a group: present, not departed, not the
 * local device, not already a member. Optionally narrowed by a search query
 * matched against name or hostname (case-insensitive substring).
 */
export function pickAddCandidates(
  presence: PresenceView[],
  selfDeviceId: string,
  currentMembers: readonly string[],
  query = '',
): PresenceView[] {
  const q = query.trim().toLowerCase()
  const members = new Set(currentMembers)
  return presence
    .filter((p) => !p.departed && p.deviceId !== selfDeviceId && !members.has(p.deviceId))
    .filter((p) => q === '' || p.name.toLowerCase().includes(q) || p.hostname.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface SelfIdentity {
  deviceId: string
  name: string
  hostname: string
  fingerprint: string
}

const RANK = { online: 0, away: 1, offline: 2 } as const

/**
 * Presence rows for a group's current members, in display order (online
 * first, then away, then offline; alphabetical within each tier). `presence`
 * never includes the local device (the main process filters it out of the
 * roster), so `self` is spliced in directly wherever the member list names
 * it — which it always does, for a group this device can even see.
 * `selfConv` fills the unused-but-required PresenceView.dmConv field.
 */
export function groupMemberRows(
  members: readonly string[],
  presence: PresenceView[],
  self: SelfIdentity | null,
  selfConv: ConvId,
): PresenceView[] {
  const rows: PresenceView[] = []
  for (const id of members) {
    if (self && id === self.deviceId) {
      rows.push({
        deviceId: self.deviceId,
        name: self.name,
        hostname: self.hostname,
        fingerprint: self.fingerprint,
        state: 'online',
        status: '',
        lastSeenMs: null,
        trust: 'trusted',
        dmConv: selfConv,
        departed: false,
      })
      continue
    }
    const p = presence.find((pp) => pp.deviceId === id)
    // A member presence hasn't been seen (or is no longer roster-visible) —
    // skip rather than fabricate a row, matching how the channel members
    // list only ever shows what presence actually knows.
    if (p) rows.push(p)
  }
  return rows.sort((a, b) => RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name))
}
