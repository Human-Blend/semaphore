import type { PresenceView } from '@shared/types'

// Delete-channel warning (1.2 review fix): `PresenceView.app` is populated by
// 1.2+ writers' beacons and absent for anything older. A 1.1.x client has no
// idea what a `channel-deleted` sys event is (it isn't in its `sysLine`
// default, and it never learns the channel folded away), so it just keeps
// posting into a channel this device has already hidden. Kept dependency-free
// and pure so it's testable without React (outdatedPeers.test.ts).

/** The first version whose beacon understands channel/group tombstones. */
export const CHANNEL_TOMBSTONE_AWARE_VERSION = '1.2.0'

/**
 * True when `version` is missing (pre-1.2, or a 1.2+ client that hasn't
 * beaconed yet) or dotted-numeric-older than `floor`. Plain `x.y.z` compare —
 * app versions here never carry a prerelease/build suffix.
 */
export function isOlderApp(version: string | undefined, floor: string = CHANNEL_TOMBSTONE_AWARE_VERSION): boolean {
  if (!version) return true
  const a = version.split('.').map((n) => Number(n) || 0)
  const b = floor.split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av < bv) return true
    if (av > bv) return false
  }
  return false
}

/**
 * How many currently-present (non-departed) teammates are running a Chat
 * build that can't see a channel tombstone — the count the delete-channel
 * confirm dialog warns with.
 */
export function countPreTombstonePeers(presence: readonly PresenceView[]): number {
  return presence.filter((p) => !p.departed && isOlderApp(p.app)).length
}
