import type { EventId, EventType } from './types'
import { FILE_EXT } from './constants'

// Crockford base32 (no I, L, O, U) — used for fingerprints, dir tokens, seqs.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function base32Crockford(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let acc = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31]
  return out
}

/** 8-char base36 monotonic sequence for beacon filenames. */
export function seqToBase36(n: number): string {
  return n.toString(36).toUpperCase().padStart(8, '0')
}

export function base36ToSeq(s: string): number {
  return parseInt(s, 36)
}

// ---------------------------------------------------------------------------
// Event file naming: "<hlcMs 13>-<ctr 4>-<deviceId8>.<type>.e1"

// `grp` (1.2) is last on purpose: a 1.1 client's copy of this pattern does not
// list it, so a `.grp.e1` file simply doesn't parse there and is skipped in
// silence — which is exactly what we want a private-group notice to do on an
// old client, rather than render as a blank sys row.
const EVENT_RE = /^(\d{13})-(\d{4})-([0-9a-f]{8})\.(msg|edt|del|rct|pin|sys|prv|cal|prs|grp)\.e1$/

export function eventFileName(hlcMs: number, ctr: number, deviceId: string, type: EventType): string {
  return `${String(hlcMs).padStart(13, '0')}-${String(ctr).padStart(4, '0')}-${deviceId.slice(0, 8)}.${type}${FILE_EXT.record}`
}

export function eventStem(hlcMs: number, ctr: number, deviceId: string): string {
  return `${String(hlcMs).padStart(13, '0')}-${String(ctr).padStart(4, '0')}-${deviceId.slice(0, 8)}`
}

export function parseEventFileName(name: string): (EventId & { type: EventType }) | null {
  const m = EVENT_RE.exec(name)
  if (!m) return null
  return {
    hlcMs: Number(m[1]),
    ctr: Number(m[2]),
    deviceId8: m[3],
    stem: `${m[1]}-${m[2]}-${m[3]}`,
    type: m[4] as EventType,
  }
}

/** UTC day-shard directory name for an HLC timestamp. */
export function dayShard(hlcMs: number): string {
  return new Date(hlcMs).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Conversation-kind guards. Use these instead of hand-rolled startsWith() so a
// third conversation kind can never fall into the wrong branch by accident.

export function isTeamConv(conv: string): conv is `team:${string}` {
  return conv.startsWith('team:')
}

export function isChanConv(conv: string): conv is `chan:${string}` {
  return conv.startsWith('chan:')
}

export function isDmConv(conv: string): conv is `dm:${string}` {
  return conv.startsWith('dm:')
}

export function isGrpConv(conv: string): conv is `grp:${string}` {
  return conv.startsWith('grp:')
}

// ---------------------------------------------------------------------------
// rtc signal naming: "<ms 13>-<sess8>-<seq3>-<from8>-<to8>-<type>.sig"

const SIGNAL_RE = /^(\d{13})-([0-9a-f]{8})-(\d{3})-([0-9a-f]{8})-([0-9a-f]{8})-(offer|answer|bye|busy)\.sig$/

export function signalFileName(
  ms: number,
  sessionId: string,
  seq: number,
  from: string,
  to: string,
  type: string,
): string {
  return `${String(ms).padStart(13, '0')}-${sessionId.slice(0, 8)}-${String(seq).padStart(3, '0')}-${from.slice(0, 8)}-${to.slice(0, 8)}-${type}${FILE_EXT.signal}`
}

export interface ParsedSignalName {
  ms: number
  sess8: string
  seq: number
  from8: string
  to8: string
  type: 'offer' | 'answer' | 'bye' | 'busy'
}

export function parseSignalFileName(name: string): ParsedSignalName | null {
  const m = SIGNAL_RE.exec(name)
  if (!m) return null
  return {
    ms: Number(m[1]),
    sess8: m[2],
    seq: Number(m[3]),
    from8: m[4],
    to8: m[5],
    type: m[6] as ParsedSignalName['type'],
  }
}

// ---------------------------------------------------------------------------
// Beacon naming: "<deviceId8>.<seq base36 8>"

const BEACON_RE = /^([0-9a-f]{8})\.([0-9A-Z]{8})$/

export function beaconFileName(deviceId: string, seq: number): string {
  return `${deviceId.slice(0, 8)}.${seqToBase36(seq)}`
}

export function parseBeaconFileName(name: string): { deviceId8: string; seq: number } | null {
  const m = BEACON_RE.exec(name)
  if (!m) return null
  return { deviceId8: m[1], seq: base36ToSeq(m[2]) }
}

// ---------------------------------------------------------------------------

/** Human fingerprint chip: first 40 bits of SHA-256(edPub) → "Q7RC-2MZE". */
export function formatFingerprint(sha256OfEdPub: Uint8Array): string {
  const s = base32Crockford(sha256OfEdPub.subarray(0, 5))
  return `${s.slice(0, 4)}-${s.slice(4, 8)}`
}

/** Sanitized hostname for the identity chip (≤12 chars, uppercase-ish). */
export function sanitizeHostname(hostname: string): string {
  const cleaned = hostname.replace(/\.(local|lan|corp|home|internal)\.?$/i, '').replace(/[^\w-]/g, '')
  return cleaned.slice(0, 12).toUpperCase() || 'UNKNOWN'
}
