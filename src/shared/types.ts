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

export type EventType = 'msg' | 'edt' | 'del' | 'rct' | 'pin' | 'sys' | 'prv'

export interface EventId {
  hlcMs: number
  ctr: number
  deviceId8: string
  stem: string // "<13>-<4>-<8>"
}

export type ConvId = `chan:${string}` | `dm:${string}` // dm:<pairToken>

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

export type EventPayload =
  | MsgPayload
  | EdtPayload
  | DelPayload
  | RctPayload
  | PinPayload
  | PrvPayload
  | SysPayload

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
  cursors: Record<string, { read: string; ingested: string }>
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
  cursor: { read: string; ingested: string }
  typingUntil?: number
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

export interface PresenceView {
  deviceId: string
  name: string
  hostname: string
  fingerprint: string // "Q7RC-2MZE" — computed from the pinned verifying key
  state: PresenceStateKind
  status: string
  lastSeenMs: number | null
  trust: TrustState
}
