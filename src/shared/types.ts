// Wire types for everything that crosses the shared folder or the IPC bridge.
// All timestamps are share-calibrated milliseconds unless suffixed Wall.

// ---------------------------------------------------------------------------
// Identity

export interface DeviceRecord {
  type: 'device-record'
  v: 1
  deviceId: string // 32 hex chars = SHA-256(edPub)[0..16]
  edPub: string // base64url raw 32 bytes
  xPub: string // base64url raw 32 bytes
  displayName: string
  hostname: string
  osUser: string
  platform: 'darwin' | 'win32' | 'linux'
  machineIdHash: string | null // SHA-256("smbchat-mid"||machineGuid) hex, null when unavailable
  firstSeen: number
  recSeq: number // monotonic; readers reject regressions
}

export interface Revocation {
  type: 'revocation'
  target: string // deviceId being revoked
  reason: string
  at: number
}

/** Local TOFU pin state for a device. */
export type TrustState = 'pinned' | 'trusted' | 'flagged' | 'revoked'

export interface DevicePin {
  deviceId: string
  edPub: string
  xPub: string
  displayName: string
  hostname: string
  firstSeen: number
  trust: TrustState
}

// ---------------------------------------------------------------------------
// Events (one file per event; filename stem is the event id)

export type EventType = 'msg' | 'edt' | 'del' | 'rct' | 'pin' | 'sys' | 'prv' | 'cal' | 'prs'

export interface EventId {
  hlcMs: number
  ctr: number
  deviceId8: string
  stem: string // "<13>-<4>-<8>"
}

// dm:<pairToken>; team:<fixed name> — team convs are app-defined logs
// (see TEAM_CONV) that live under DIR.team and are never day-swept.
export type ConvId = `chan:${string}` | `dm:${string}` | `team:${string}`

export type BodyEntity =
  | { type: 'code'; lang: string | null; start: number; end: number }
  | { type: 'mention'; device?: string; special?: 'here'; start: number; end: number }
  | { type: 'link'; url: string; start: number; end: number }

export interface Attachment {
  blobId: string // 32 hex
  key: string // base64 32-byte blobKey
  name: string
  size: number
  mime: string
  sha256: string // hex of plaintext
  w?: number
  h?: number
  durMs?: number
  thumb?: string // data: URI, <= EVENT.maxThumbBytes
}

export interface LinkPreview {
  url: string
  title?: string
  desc?: string
  img?: string // data: URI WebP
  domain: string
  failed?: boolean // fetch attempted and blocked — render honest degraded card
  /** Why it failed (absent on pre-1.0.2 senders: treat as 'network'). */
  reason?: 'network' | 'http' | 'nometa'
}

export interface MsgBody {
  kind: 'text' | 'code' | 'gif'
  text: string
  lang?: string | null // kind:'code'
  packId?: string // kind:'gif' from the bundled pack — zero share I/O
  entities?: BodyEntity[]
}

export interface MsgPayload {
  t: 'msg'
  conv: ConvId
  author: { device: string; name: string }
  senderSeq: number // per-device monotonic — deletion detection
  sentWall: number // sender wall clock, display only
  body: MsgBody
  replyTo?: string // event stem
  attachments?: Attachment[]
  linkPreview?: LinkPreview
}

export interface EdtPayload {
  t: 'edt'
  conv: ConvId
  target: string
  body: MsgBody
}

export interface DelPayload {
  t: 'del'
  conv: ConvId
  target: string
}

export interface RctPayload {
  t: 'rct'
  conv: ConvId
  target: string
  emoji: string
  op: 'add' | 'remove'
}

export interface PinPayload {
  t: 'pin'
  conv: ConvId
  target: string
  op: 'pin' | 'unpin'
}

export interface PrvPayload {
  t: 'prv'
  conv: ConvId
  target: string
  linkPreview: LinkPreview
}

export interface SysPayload {
  t: 'sys'
  conv: ConvId
  kind:
    | 'channel-created'
    | 'channel-renamed'
    | 'topic-changed'
    | 'name-changed'
    | 'beam-receipt'
    | 'purge-blob'
    | 'screenshare'
    | 'screenshare-ended'
  data: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Team calendar (conv 'team:calendar', event type 'cal')

export interface CalendarEntry {
  id: string // 16 hex, random, chosen by the creator; stable across edits
  title: string // <= 120 chars
  tag: string // <= 24 chars, free text ('Release', 'Freeze', 'Birthday', …)
  color: number // 0..7 -> var(--hue-N)
  start: string // 'YYYY-MM-DD' (calendar date, no timezone)
  end: string // 'YYYY-MM-DD' inclusive; === start for single-day
  annual: boolean // repeats every year on the same month/day (birthdays)
  notes: string // '' when empty — never undefined (canonical JSON)
}

export type CalPayload =
  | { t: 'cal'; conv: ConvId; op: 'put'; entry: CalendarEntry }
  | { t: 'cal'; conv: ConvId; op: 'del'; id: string }

// ---------------------------------------------------------------------------
// Pull-request group (conv 'team:prs', event type 'prs')

export interface PrsRepo {
  id: string
  name: string
}

export interface PrsConfig {
  /** 'https://dev.azure.com/org' | 'https://tfs.corp/tfs/DefaultCollection' — no trailing slash. */
  baseUrl: string
  project: string // project name (or id)
  repos: PrsRepo[] // watched repositories; empty = nothing tracked
  sharedToken: string // '' when the configurer chose not to share
}

/** Full snapshot of the group config; LWW by event stem. */
export type PrsPayload = { t: 'prs'; conv: ConvId; config: PrsConfig }

export type EventPayload =
  | MsgPayload
  | EdtPayload
  | DelPayload
  | RctPayload
  | PinPayload
  | PrvPayload
  | SysPayload
  | CalPayload
  | PrsPayload

/** What actually gets encrypted into an .e1 file. */
export interface SignedRecord<T = unknown> {
  p: T
  by: string // author deviceId (32 hex) — key lookup for verification
  sig: string // base64 Ed25519 over DST || 0x00 || canonicalJSON(p)
}

// ---------------------------------------------------------------------------
// Beacon

export type PresenceStateKind = 'online' | 'away' | 'offline'

export interface BeaconContent {
  device: string
  name: string
  seq: string // base36, 8 chars, mirrors filename
  hlc: number
  presence: { state: PresenceStateKind; status: string; idleSec: number }
  typing?: { conv: ConvId; until: number }
  /** Last N event filenames this device wrote, per conversation (channels only). */
  heads: Record<string, string[]>
  /** Read/ingest watermarks per conversation (channels only). */
  cursors: Record<string, Cursor>
  /** DM section: pairToken -> SFC1-under-pair-key, base64. Hides DM activity from the team. */
  dmSealed?: Record<string, string>
  /** Live upload progress: blobId -> chunks done/total. */
  xfers?: Record<string, { done: number; total: number }>
  /** Drop hints: recipientDeviceId -> hlc of newest drop placed. */
  drops?: Record<string, number>
  /** P2P reachability. */
  lanIps?: string[]
  p2p?: { caps: string[]; wsPort?: number }
}

/** The pair-key-encrypted part of a beacon for one DM. */
export interface DmBeaconSection {
  heads: string[]
  cursor: Cursor
  typingUntil?: number
}

/** A device's watermarks in one conversation: event stems, plus when it last read. */
export interface Cursor {
  read: string
  ingested: string
  readAt?: number // share-calibrated ms; absent from pre-1.0.2 beacons
}

// ---------------------------------------------------------------------------
// Channel / team metadata

export interface ChannelMeta {
  type: 'channel'
  channelId: string // 8 hex, random
  name: string
  topic: string
  creator: string
  created: number
}

export interface TeamConfig {
  type: 'team-config'
  teamName: string
  admins: string[] // deviceIds allowed to del others' messages
  retention?: Partial<{
    eventDays: number
    blobDays: number
    dropHours: number
  }>
  defaultChannels?: string[]
}

export interface ProtocolFile {
  protocol: 'fdc'
  version: number
  minReader: number
  minWriter: number
  teamId: string
  teamName: string
  epoch: number
  kdf: { alg: 'scrypt'; N: number; r: number; p: number; saltB64: string }
  check: string // HMAC prefix (base64) for instant wrong-passphrase detection
  created: number
}

// ---------------------------------------------------------------------------
// Drops (beams)

export interface DropOffer {
  type: 'drop-offer'
  dropId: string
  from: string
  name: string
  size: number
  mime: string
  sha256: string
  blobKey: string // base64
  note?: string
  thumb?: string
}

export interface DropAck {
  type: 'drop-ack'
  dropId: string
  state: 'accepted' | 'receiving' | 'saved' | 'declined'
  bytesDone?: number
}

// ---------------------------------------------------------------------------
// RTC signaling

export type RtcSignalType = 'offer' | 'answer' | 'bye' | 'busy'
export type RtcPurpose = 'screenshare' | 'xfer'

export interface RtcSignal {
  type: 'rtc'
  sessionId: string // 16 hex
  purpose: RtcPurpose
  signal: RtcSignalType
  from: string
  to: string
  sdp?: string
  reason?: 'ended' | 'fallback' | 'error' | 'declined' | 'upgraded'
  /** xfer offers carry metadata so the receiver can accept/decline pre-answer. */
  xmeta?: { name: string; size: number; mime: string; resumeFrom?: number }
}

export interface ScreenshareAnnounce {
  sessionId: string
  presenterDevice: string
  frameKey: string // base64, wrapped by conversation encryption already
  nonceBase: string // base64 4 bytes
  w: number
  h: number
  gen: number
}

// ---------------------------------------------------------------------------
// Updates

export interface VersionManifest {
  schema: 1
  version: string
  released: string
  minSupported: string
  notes: string
  files: Record<string, { name: string; sha256: string; bytes: number }>
  sig: string
}

// ---------------------------------------------------------------------------
// Renderer-facing view models (decrypted, verified)

export interface VerifiedEvent {
  id: string // stem
  type: EventType
  payload: EventPayload
  author: string // deviceId
  verified: boolean
  receivedAt: number
}

// ---------------------------------------------------------------------------
// Azure DevOps (pull-request group). Lives here — not in services/ado.ts — so
// bridge.ts can name these types without importing main-process code.

export type AdoErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'proxy-auth'
  | 'tls'
  | 'dns'
  | 'network'
  | 'timeout'
  | 'http'
  | 'bad-url'
  | 'api-version'

/** `detail` never contains the token. */
export interface AdoError {
  code: AdoErrorCode
  detail: string
}

export type AdoResult<T> = { ok: true; value: T } | { ok: false; error: AdoError }

export interface PrView {
  key: string // `${repoId}:${pullRequestId}`
  id: number
  title: string
  repoId: string
  repoName: string
  author: { id: string; name: string }
  sourceBranch: string // 'refs/heads/' stripped
  targetBranch: string // 'refs/heads/' stripped
  createdAt: number // ms epoch
  isDraft: boolean
  reviewers: { id: string; name: string; vote: number; required: boolean }[]
  assignedToMe: boolean // I appear in reviewers
  myVote: number // 0 when not a reviewer
  webUrl: string
  seen: boolean
}

export interface PrsStatus {
  configured: boolean
  baseUrl: string
  project: string
  repos: PrsRepo[]
  tokenSource: 'personal' | 'shared' | 'none'
  /** True when the team config currently carries a shared token (independent of tokenSource, which is per viewer). */
  sharedTokenSet: boolean
  me: { id: string; name: string } | null
  lastPollAt: number | null
  polling: boolean
  error: AdoError | null
  unseen: number
}

export type PrsProbe =
  | { ok: true; me: { id: string; name: string }; projects: { id: string; name: string }[]; apiVersion: string }
  | { ok: false; error: AdoError }

export interface PresenceView {
  deviceId: string
  name: string
  hostname: string
  fingerprint: string // "Q7RC-2MZE" — computed from the pinned verifying key
  state: PresenceStateKind
  status: string
  lastSeenMs: number | null
  trust: TrustState
  dmConv: ConvId
  /**
   * Nobody is behind this registration any more (swept beacon, quiet for
   * days, or superseded by a re-setup). Kept in the list so names still
   * resolve and pending DM traffic stays reachable; roster surfaces hide it.
   */
  departed: boolean
}
