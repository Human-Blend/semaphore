import { BrowserWindow, Notification } from 'electron'
import type {
  ChannelView,
  CursorView,
  DmView,
  PushMessage,
  SendDraft,
  SettingsView,
} from '@shared/bridge'
import type { Attachment, ConvId, EventPayload, MsgPayload, PresenceView, VerifiedEvent } from '@shared/types'
import type { AttachDraft } from '@shared/bridge'
import { POLL } from '@shared/constants'
import { EventStore } from '../transport/events'
import { BeaconWriter } from '../transport/beacon'
import { Poller } from '../transport/poller'
import type { Session } from '../transport/session'

// Orchestrates the live chat slice: event publishing with an offline outbox,
// beacon lifecycle, polling, cursors/read receipts, notifications.

interface OutboxItem {
  conv: ConvId
  type: 'msg'
  payload: MsgPayload
}

export class ChatService {
  readonly events: EventStore
  readonly beacon: BeaconWriter
  readonly poller: Poller
  private remoteCursors = new Map<ConvId, Map<string, CursorView>>()
  private outbox: OutboxItem[] = []
  private push: (msg: PushMessage) => void
  /** Set by the drops service: a peer's beacon hinted at a new drop for us. */
  dropHintHandler: ((fromDeviceId: string) => void) | null = null
  /** Set by the blobs service: a peer's beacon carried upload progress. */
  xferHandler: ((deviceId: string, xfers: Record<string, { done: number; total: number }>) => void) | null = null
  /** Set by the blobs service: uploads local files, returns attachment refs. */
  attachmentUploader: ((items: AttachDraft[], conv: ConvId) => Promise<Attachment[]>) | null = null

  constructor(
    readonly session: Session,
    private getWindow: () => BrowserWindow | null,
    private getSettings: () => SettingsView,
  ) {
    this.events = new EventStore(session)
    this.beacon = new BeaconWriter(session)
    this.poller = new Poller(session, this.events)
    this.outbox = session.store.readSecretJson<OutboxItem[]>('outbox') ?? []
    this.push = () => {}
  }

  setPush(push: (msg: PushMessage) => void): void {
    this.push = push
  }

  async start(): Promise<void> {
    const s = this.session

    this.events.onEvent((conv, event) => {
      this.push({ kind: 'event', conv, event })
      if (event.author !== s.deviceId) {
        this.beacon.setCursor(conv, {
          read: this.readCursor(conv),
          ingested: this.events.newestStem(conv) ?? '',
        })
        this.maybeNotify(conv, event)
      }
    })

    this.poller.listeners = {
      onPresence: (views: PresenceView[]) => this.push({ kind: 'presence', views }),
      onTyping: (conv, deviceId, until) => this.push({ kind: 'typing', conv, deviceId, until }),
      onCursors: (conv, deviceId, cursor) => {
        let m = this.remoteCursors.get(conv)
        if (!m) this.remoteCursors.set(conv, (m = new Map()))
        m.set(deviceId, cursor)
        this.push({ kind: 'cursors', conv, deviceId, cursor })
      },
      onHealthChange: (reachable) => {
        this.push({ kind: 'health', health: { reachable, latencyMs: s.io.getHealth().latencyMs } })
        if (reachable) void this.flushOutbox()
      },
      onNewDevice: () => {
        s.refreshDms()
        this.push({ kind: 'presence', views: this.poller.presenceViews() })
        void this.pushChannels()
      },
      onDropHint: (from) => this.dropHintHandler?.(from),
      onXfers: (deviceId, xfers) => this.xferHandler?.(deviceId, xfers),
    }

    await s.roster.refresh()
    s.refreshDms()
    await s.loadChannels()
    if (s.channels.size === 0) {
      await s.createChannel('general', 'Team-wide chat').catch(() => {})
    }
    for (const ch of s.channels.values()) {
      await this.events.catchUp(s.convIdForChannel(ch.channelId))
    }
    for (const dm of s.dms.values()) {
      await this.events.catchUp(`dm:${dm.pairToken}`)
    }

    this.beacon.start()
    this.poller.start()
    await this.pushChannels()
    this.push({ kind: 'presence', views: this.poller.presenceViews() })
  }

  async stop(): Promise<void> {
    this.poller.stop()
    await this.beacon.stop(true)
  }

  // -------------------------------------------------------------------------

  channelViews(): ChannelView[] {
    return [...this.session.channels.values()].map((ch) => ({
      conv: `chan:${ch.channelId}` as ConvId,
      channelId: ch.channelId,
      name: ch.meta.name,
      topic: ch.meta.topic,
    }))
  }

  private async pushChannels(): Promise<void> {
    this.push({ kind: 'channels', channels: this.channelViews() })
  }

  async createChannel(name: string, topic = ''): Promise<ChannelView> {
    const ch = await this.session.createChannel(name, topic)
    await this.pushChannels()
    return { conv: `chan:${ch.channelId}`, channelId: ch.channelId, name: ch.meta.name, topic: ch.meta.topic }
  }

  dmFor(peerDeviceId: string): DmView | null {
    const dm = this.session.dmFor(peerDeviceId)
    return dm ? { conv: `dm:${dm.pairToken}`, peerDeviceId } : null
  }

  getEvents(conv: ConvId): VerifiedEvent[] {
    return this.events.getEvents(conv)
  }

  cursors(conv: ConvId): Record<string, CursorView> {
    return Object.fromEntries(this.remoteCursors.get(conv) ?? [])
  }

  // -------------------------------------------------------------------------

  async send(conv: ConvId, draft: SendDraft): Promise<{ id: string }> {
    const s = this.session
    let attachments: Attachment[] | undefined
    if (draft.attachments?.length) {
      if (!this.attachmentUploader) throw new Error('files-not-ready')
      attachments = await this.attachmentUploader(draft.attachments, conv)
    }
    const payload: MsgPayload = {
      t: 'msg',
      conv,
      author: { device: s.deviceId, name: s.displayName },
      senderSeq: s.nextSenderSeq(conv),
      sentWall: Date.now(),
      body: {
        kind: draft.kind,
        text: draft.text,
        lang: draft.lang,
        packId: draft.packId,
        entities: draft.entities,
      },
      replyTo: draft.replyTo,
      attachments,
      linkPreview: draft.linkPreview,
    }
    return this.publishWithOutbox(conv, payload)
  }

  private async publishWithOutbox(conv: ConvId, payload: MsgPayload): Promise<{ id: string }> {
    try {
      const ev = await this.events.publish(conv, 'msg', payload)
      this.beacon.noteOwnEvent(conv, `${ev.id}.msg.e1`)
      return { id: ev.id }
    } catch (err) {
      this.outbox.push({ conv, type: 'msg', payload })
      this.session.store.writeSecretJson('outbox', this.outbox)
      this.push({ kind: 'outbox', queued: this.outbox.length })
      this.push({ kind: 'health', health: { reachable: false, latencyMs: null } })
      throw err
    }
  }

  private async flushOutbox(): Promise<void> {
    const queued = this.outbox
    this.outbox = []
    for (const item of queued) {
      try {
        // Fresh HLC stamp on flush; original sentWall preserved for display.
        const ev = await this.events.publish(item.conv, 'msg', item.payload)
        this.beacon.noteOwnEvent(item.conv, `${ev.id}.msg.e1`)
      } catch {
        this.outbox.push(item)
      }
    }
    this.session.store.writeSecretJson('outbox', this.outbox)
    this.push({ kind: 'outbox', queued: this.outbox.length })
  }

  async mutate(conv: ConvId, type: 'edt' | 'del' | 'rct' | 'pin', payload: EventPayload): Promise<void> {
    const ev = await this.events.publish(conv, type, payload)
    this.beacon.noteOwnEvent(conv, `${ev.id}.${type}.e1`)
  }

  // -------------------------------------------------------------------------

  private readCursors = new Map<ConvId, string>()

  private readCursor(conv: ConvId): string {
    return this.readCursors.get(conv) ?? ''
  }

  markRead(conv: ConvId, stem: string): void {
    const prev = this.readCursors.get(conv) ?? ''
    if (stem <= prev) return
    this.readCursors.set(conv, stem)
    this.beacon.setCursor(conv, { read: stem, ingested: this.events.newestStem(conv) ?? stem })
  }

  setTyping(conv: ConvId | null): void {
    this.beacon.setTyping(conv)
  }

  // -------------------------------------------------------------------------

  private maybeNotify(conv: ConvId, event: VerifiedEvent): void {
    if (event.type !== 'msg' || !event.verified) return
    const win = this.getWindow()
    if (win?.isFocused()) return // in-app treatment only
    const settings = this.getSettings()
    const p = event.payload as MsgPayload
    const isDm = conv.startsWith('dm:')
    const mentioned = (p.body.entities ?? []).some(
      (e) => e.type === 'mention' && (e.special === 'here' || e.device === this.session.deviceId),
    )
    if (!isDm && settings.notifyChannels === 'none') return
    if (!isDm && settings.notifyChannels === 'mentions' && !mentioned) return
    if (!Notification.isSupported()) return

    const entry = this.session.roster.get(event.author)
    const who = entry ? `${p.author.name}` : 'Someone'
    const chName = !isDm ? this.session.channels.get(conv.slice(5))?.meta.name : null
    const title = settings.notifyPreviews ? (isDm ? who : `${who} in #${chName ?? 'channel'}`) : 'Semaphore'
    const body = settings.notifyPreviews
      ? p.body.kind === 'gif'
        ? 'sent a GIF'
        : p.body.text.slice(0, 140)
      : isDm
        ? 'New direct message'
        : 'New message'
    const n = new Notification({ title, body, silent: false })
    n.on('click', () => {
      win?.show()
      win?.focus()
      this.push({ kind: 'typing', conv, deviceId: '', until: 0 }) // no-op nudge; renderer routes via focus event
    })
    n.show()
  }

  focusPollRate(focused: boolean): void {
    this.poller.intervalMs = focused ? POLL.focusedMs : POLL.backgroundMs
  }
}
