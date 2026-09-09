import { BrowserWindow, Notification } from 'electron'
import type {
  ChannelView,
  CursorView,
  DmView,
  PushMessage,
  SendDraft,
  SettingsView,
} from '@shared/bridge'
import type {
  Attachment,
  CalPayload,
  ConvId,
  Cursor,
  EventPayload,
  MsgPayload,
  PresenceView,
  PrsPayload,
  VerifiedEvent,
} from '@shared/types'
import type { AttachDraft } from '@shared/bridge'
import { POLL, TEAM_CONV } from '@shared/constants'
import { isDmConv, isTeamConv } from '@shared/ids'
import { EventStore } from '../transport/events'
import { BeaconWriter } from '../transport/beacon'
import { Poller } from '../transport/poller'
import type { Session } from '../transport/session'

// Orchestrates the live chat slice: event publishing with an offline outbox,
// beacon lifecycle, polling, cursors/read receipts, notifications.

/**
 * A publish that could not reach the share. Messages and team-log writes share
 * the queue: a share mounted later replays both in order.
 */
type OutboxItem =
  | { conv: ConvId; type: 'msg'; payload: MsgPayload }
  | { conv: `team:${string}`; type: 'cal' | 'prs'; payload: CalPayload | PrsPayload }

/** Newest event stem this device has read in a conversation, and when. */
interface ReadMark {
  stem: string
  at: number
}

const READS_SECRET = 'read-cursors'

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
    for (const [conv, r] of Object.entries(session.store.readSecretJson<Record<string, ReadMark>>(READS_SECRET) ?? {})) {
      this.readCursors.set(conv as ConvId, r)
    }
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
        // Team logs carry no read receipts — nobody "reads" a calendar.
        if (!isTeamConv(conv)) this.beacon.setCursor(conv, this.ownCursor(conv))
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
    // Team logs (calendar, PR config): fixed ids, no discovery, no receipts.
    for (const conv of Object.values(TEAM_CONV)) {
      await this.events.catchUp(conv)
    }
    // Last launch's watermarks go into the very first beacon; without them
    // every peer's "Read"/"Delivered" would blink back to nothing.
    for (const ch of s.channels.values()) this.primeCursor(s.convIdForChannel(ch.channelId))
    for (const dm of s.dms.values()) this.primeCursor(`dm:${dm.pairToken}`)

    this.beacon.start()
    this.poller.start()
    await this.pushChannels()
    this.push({ kind: 'presence', views: this.poller.presenceViews() })

    // A backlog left by a previous run. The poller only calls onHealthChange
    // on a degraded→reachable edge, which never happens when the share is
    // reachable at launch, so nothing else would ever replay these.
    if (this.outbox.length > 0) {
      this.push({ kind: 'outbox', queued: this.outbox.length })
      void this.flushOutbox()
    }
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
    const ev = await this.publishWithOutbox({ conv, type: 'msg', payload })
    // A queued message has no id yet: the composer turns this rejection into
    // its "queued — will send when the folder is back" chip.
    if (!ev) throw new Error('queued')
    return { id: ev.id }
  }

  /**
   * Append to a team log ('team:calendar', 'team:prs'). Same outbox/degraded
   * handling as a message, so an entry added while the share is unreachable
   * still lands once it comes back — and, unlike a message, that queueing
   * resolves rather than rejects: a caller told "could not save" retries, and
   * a retried *new* entry carries a fresh id, so the team ends up with one
   * duplicate per press instead of one LWW entry.
   */
  async publishTeam(
    conv: `team:${string}`,
    type: 'cal' | 'prs',
    payload: CalPayload | PrsPayload,
  ): Promise<{ queued: boolean }> {
    const ev = await this.publishWithOutbox({ conv, type, payload })
    return { queued: ev === null }
  }

  /**
   * Publish, or hand the item to the outbox. Returns the published event, or
   * `null` when the share was unreachable and the item is queued for remount.
   * Throws only when the item could not even be queued.
   */
  private async publishWithOutbox(item: OutboxItem): Promise<VerifiedEvent | null> {
    try {
      const ev = await this.events.publish(item.conv, item.type, item.payload)
      this.beacon.noteOwnEvent(item.conv, `${ev.id}.${item.type}.e1`)
      return ev
    } catch (err) {
      this.outbox.push(item)
      try {
        this.session.store.writeSecretJson('outbox', this.outbox)
      } catch {
        // The queue itself is broken — this write really is lost.
        this.outbox.pop()
        throw err
      }
      this.push({ kind: 'outbox', queued: this.outbox.length })
      this.push({ kind: 'health', health: { reachable: false, latencyMs: null } })
      return null
    }
  }

  private async flushOutbox(): Promise<void> {
    const queued = this.outbox
    this.outbox = []
    for (const item of queued) {
      try {
        // Fresh HLC stamp on flush; original sentWall preserved for display.
        const ev = await this.events.publish(item.conv, item.type, item.payload)
        this.beacon.noteOwnEvent(item.conv, `${ev.id}.${item.type}.e1`)
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

  // Own read watermarks, persisted: they drive peers' receipts and this
  // device's unread badges, neither of which should reset on relaunch.
  private readCursors = new Map<ConvId, ReadMark>()

  private ownCursor(conv: ConvId): Cursor {
    const mark = this.readCursors.get(conv)
    const ingested = this.events.newestStem(conv) ?? mark?.stem ?? ''
    return mark ? { read: mark.stem, ingested, readAt: mark.at } : { read: '', ingested }
  }

  private primeCursor(conv: ConvId): void {
    const cur = this.ownCursor(conv)
    if (cur.read || cur.ingested) this.beacon.primeCursor(conv, cur)
  }

  myReads(): Record<ConvId, string> {
    const out: Record<string, string> = {}
    for (const [conv, mark] of this.readCursors) out[conv] = mark.stem
    return out
  }

  markRead(conv: ConvId, stem: string): void {
    if (isTeamConv(conv)) return // team logs have no unread state and no receipts
    const prev = this.readCursors.get(conv)?.stem ?? ''
    if (stem <= prev) return
    this.readCursors.set(conv, { stem, at: this.session.io.calibratedNow() })
    this.session.store.writeSecretJson(READS_SECRET, Object.fromEntries(this.readCursors))
    this.beacon.setCursor(conv, this.ownCursor(conv))
  }

  setTyping(conv: ConvId | null): void {
    this.beacon.setTyping(conv)
  }

  // -------------------------------------------------------------------------

  private maybeNotify(conv: ConvId, event: VerifiedEvent): void {
    // Calendar edits never toast; PR alerts are the PR service's job.
    if (isTeamConv(conv)) return
    if (event.type !== 'msg' || !event.verified) return
    const win = this.getWindow()
    if (win?.isFocused()) return // in-app treatment only
    const settings = this.getSettings()
    const p = event.payload as MsgPayload
    const isDm = isDmConv(conv)
    const mentioned = (p.body.entities ?? []).some(
      (e) => e.type === 'mention' && (e.special === 'here' || e.device === this.session.deviceId),
    )
    if (!isDm && settings.notifyChannels === 'none') return
    if (!isDm && settings.notifyChannels === 'mentions' && !mentioned) return
    if (!Notification.isSupported()) return

    const entry = this.session.roster.get(event.author)
    const who = entry ? `${p.author.name}` : 'Someone'
    const chName = !isDm ? this.session.channels.get(conv.slice(5))?.meta.name : null
    const title = settings.notifyPreviews ? (isDm ? who : `${who} in #${chName ?? 'channel'}`) : 'Chat'
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
