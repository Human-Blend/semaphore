// The complete typed contract between renderer and main. The preload script
// implements exactly this shape; renderer code accesses it as window.bridge.
// FROZEN: UI and main-side services are built against these types in parallel.

import type {
  ConvId,
  PresenceView,
  VerifiedEvent,
  BodyEntity,
  LinkPreview,
  RtcSignal,
  TrustState,
} from './types'

// ---------------------------------------------------------------------------
// View models

export type BootMode =
  | { mode: 'onboarding'; sharePathSuggestion: string | null; savedName?: string | null }
  | { mode: 'locked' } // passphrase-LMK machines: unlock each launch
  | { mode: 'ready'; self: SelfView }

export interface SelfView {
  deviceId: string
  displayName: string
  hostname: string // sanitized, for the chip
  fingerprint: string // "Q7RC-2MZE"
  teamName: string
  sharePath: string
  platform: 'darwin' | 'win32' | 'linux'
}

export interface ChannelView {
  conv: ConvId
  channelId: string
  name: string
  topic: string
}

export interface DmView {
  conv: ConvId
  peerDeviceId: string
}

export interface HealthView {
  reachable: boolean
  latencyMs: number | null
}

export interface OnboardHealth {
  writable: boolean
  readBack: boolean
  latencyMs: number
  existingTeamName: string | null
}

export interface AttachDraft {
  path: string
  /** Renderer-generated inline thumbnail (data: URI ≤ 24KB) for media. */
  thumb?: string
  w?: number
  h?: number
  durMs?: number
}

export interface SendDraft {
  text: string
  kind: 'text' | 'code' | 'gif'
  lang?: string | null
  packId?: string
  entities?: BodyEntity[]
  replyTo?: string
  /** Files to attach — uploaded to the blob store, then referenced. */
  attachments?: AttachDraft[]
  /** Pre-fetched link preview (composer fetches via bridge.links.preview). */
  linkPreview?: LinkPreview
}

export interface CursorView {
  read: string
  ingested: string
}

export interface BeamOfferView {
  dropId: string
  fromDeviceId: string
  name: string
  size: number
  mime: string
  note?: string
  thumb?: string
}

export interface BeamProgressView {
  dropId: string
  direction: 'send' | 'receive'
  peerDeviceId: string
  name: string
  size: number
  bytesDone: number
  transport: 'p2p' | 'folder'
  state: 'connecting' | 'waiting' | 'transferring' | 'saved' | 'declined' | 'failed' | 'canceled' | 'expired'
  savedPath?: string
}

export interface BlobFetchState {
  blobId: string
  state: 'idle' | 'downloading' | 'ready' | 'failed' | 'expired'
  bytesDone: number
  bytesTotal: number
  /** sfblob:// URL once ready (or progressively playable). */
  url: string | null
}

export interface ScreenSourceView {
  id: string
  name: string
  kind: 'screen' | 'window'
  thumbnailDataUrl: string
  appIconDataUrl?: string
}

export interface ScreenSessionView {
  sessionId: string
  presenterDevice: string
  conv: ConvId
  mode: 'p2p' | 'relay' | 'connecting' | 'ended'
  viewers: number
}

export interface UpdateView {
  version: string
  notes: string
  blocking: boolean
}

export interface SettingsView {
  theme: 'system' | 'dark' | 'light'
  notifyChannels: 'all' | 'mentions' | 'none'
  notifyPreviews: boolean
  autoplayGifs: 'always' | 'hover' | 'never'
  autoAcceptBeams: boolean
  quietHours: { enabled: boolean; from: string; to: string }
  fontSize: 'S' | 'M' | 'L'
}

// ---------------------------------------------------------------------------
// Event pushes (main → renderer). One 'push' channel, discriminated payloads.

export type PushMessage =
  | { kind: 'boot'; boot: BootMode }
  | { kind: 'event'; conv: ConvId; event: VerifiedEvent }
  | { kind: 'channels'; channels: ChannelView[] }
  | { kind: 'presence'; views: PresenceView[] }
  | { kind: 'typing'; conv: ConvId; deviceId: string; until: number }
  | { kind: 'cursors'; conv: ConvId; deviceId: string; cursor: CursorView }
  | { kind: 'health'; health: HealthView }
  | { kind: 'outbox'; queued: number } // messages waiting for remount
  | { kind: 'beam-offer'; offer: BeamOfferView }
  | { kind: 'beam-progress'; progress: BeamProgressView }
  | { kind: 'blob'; state: BlobFetchState }
  | { kind: 'screen-session'; session: ScreenSessionView }
  | { kind: 'update'; update: UpdateView }
  | { kind: 'skew-warning'; deviceId: string }
  | { kind: 'rtc-signal'; signal: RtcSignal }
  | { kind: 'frame'; sessionId: string; seq: number; bytes: Uint8Array }
  | { kind: 'frame-viewers'; sessionId: string; count: number }

// ---------------------------------------------------------------------------
// The bridge surface

export interface BridgeApi {
  platform: 'darwin' | 'win32' | 'linux'
  versions: { electron: string; chrome: string }

  /** Subscribe to all main→renderer pushes. Returns unsubscribe. */
  onPush(cb: (msg: PushMessage) => void): () => void

  app: {
    getBoot(): Promise<BootMode>
    unlock(passphrase: string): Promise<boolean>
    /** Disconnect from the current team folder and re-enter setup (name kept). */
    changeTeamFolder(): Promise<void>
    openExternal(url: string): Promise<void>
    copyText(text: string): Promise<void>
    showInFolder(path: string): Promise<void>
    setBadge(count: number): Promise<void>
  }

  onboarding: {
    pickFolder(): Promise<string | null>
    healthCheck(path: string): Promise<OnboardHealth>
    detectDevice(): Promise<{ hostname: string }>
    submit(cfg: {
      sharePath: string
      passphrase: string
      displayName: string
      teamName: string
    }): Promise<{ ok: true } | { ok: false; error: string }>
  }

  chat: {
    channels(): Promise<ChannelView[]>
    createChannel(name: string, topic?: string): Promise<ChannelView>
    dmFor(peerDeviceId: string): Promise<DmView | null>
    /** Full raw event list for a conversation (renderer materializes). */
    events(conv: ConvId): Promise<VerifiedEvent[]>
    send(conv: ConvId, draft: SendDraft): Promise<{ id: string }>
    edit(conv: ConvId, target: string, text: string): Promise<void>
    remove(conv: ConvId, target: string): Promise<void>
    react(conv: ConvId, target: string, emoji: string, op: 'add' | 'remove'): Promise<void>
    pin(conv: ConvId, target: string, op: 'pin' | 'unpin'): Promise<void>
    markRead(conv: ConvId, stem: string): Promise<void>
    setTyping(conv: ConvId | null): Promise<void>
    /** Remote cursors known so far: conv -> deviceId -> cursor. */
    cursors(conv: ConvId): Promise<Record<string, CursorView>>
  }

  presence: {
    list(): Promise<PresenceView[]>
    setStatus(text: string): Promise<void>
    setAppearState(state: 'online' | 'offline'): Promise<void>
  }

  roster: {
    trust(deviceId: string, trust: Extract<TrustState, 'trusted' | 'flagged'>): Promise<void>
  }

  files: {
    /** Fetch (or begin fetching) a shared blob; push 'blob' reports progress. */
    fetchBlob(blobId: string, key: string, name: string, size: number): Promise<BlobFetchState>
    saveBlobAs(blobId: string, suggestedName: string): Promise<string | null>
    /** Drag-out support. */
    startDrag(blobId: string, name: string): Promise<void>
    /** Resolve a dropped DOM File to its absolute path (sync, via webUtils). */
    pathForFile(file: File): string
  }

  beams: {
    send(peerDeviceId: string, filePaths: string[]): Promise<{ dropId: string }>
    accept(dropId: string, savePath?: string): Promise<void>
    decline(dropId: string): Promise<void>
    cancel(dropId: string): Promise<void>
  }

  links: {
    /** Sender-side metadata fetch; resolves quickly with failed:true when blocked. */
    preview(url: string): Promise<LinkPreview>
  }

  gifs: {
    packList(): Promise<{ id: string; category: string; url: string; w: number; h: number }[]>
    search(q: string): Promise<{ online: boolean; results: { url: string; w: number; h: number }[] }>
  }

  screen: {
    /** Empty list + systemPicker:true → call getDisplayMedia directly (macOS 15+). */
    sources(): Promise<{ sources: ScreenSourceView[]; systemPicker: boolean }>
    permission(): Promise<'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'>
    openPermissionSettings(): Promise<void>
    /** Arm the display-media handler with the chosen source before getDisplayMedia. */
    primeSource(sourceId: string): Promise<void>
    /** Publish the screenshare announce sys event; returns session + frame key material. */
    start(conv: ConvId, w: number, h: number): Promise<{ sessionId: string; frameKey: string; nonceBase: string }>
    stop(sessionId: string, conv: ConvId): Promise<void>
    /** Begin relay-viewing: main polls the session frame dir + heartbeats. */
    join(sessionId: string): Promise<void>
    leave(sessionId: string): Promise<void>
  }

  rtc: {
    /** Encrypt+sign+write one signal file (sealed to `signal.to`). */
    send(signal: RtcSignal): Promise<void>
    /** Switch the rtc/ poll cadence: fast during handshakes/presenting. */
    setPollMode(mode: 'fast' | 'idle'): Promise<void>
  }

  frames: {
    /** Presenter: write one encrypted frame to the ring (deletes seq-ringDepth). */
    publish(sessionId: string, seq: number, bytes: Uint8Array): Promise<void>
    /** Presenter: subscribe to viewer-heartbeat counts for the session. */
    watchViewers(sessionId: string, on: boolean): Promise<void>
  }

  settings: {
    get(): Promise<SettingsView>
    set(patch: Partial<SettingsView>): Promise<SettingsView>
  }

  update: {
    copyToMachine(): Promise<{ path: string } | { error: string }>
  }
}
