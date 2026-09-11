import { POLL, PRESENCE, TEAM_CONV } from '@shared/constants'
import type { BeaconContent, ConvId, DmBeaconSection, PresenceStateKind, PresenceView } from '@shared/types'
import { fingerprintFromEdPub } from '../crypto/identity'
import { isChanConv, isTeamConv, sanitizeHostname } from '@shared/ids'
import { sweepMsFor, tickMsFor, type IoTier } from '../services/ioTier'
import { BeaconReader, type BeaconObservation } from './beacon'
import type { EventStore } from './events'
import type { RosterEntry } from './roster'
import type { Session } from './session'

// Drives the whole read side: beacon polling, event ingestion via heads,
// channel discovery, presence derivation, typing, and remote cursors.

interface DeviceObservation {
  content: BeaconContent
  verified: boolean
}

export interface PollerEvents {
  onPresence?: (views: PresenceView[]) => void
  onTyping?: (conv: ConvId, deviceId: string, until: number) => void
  onCursors?: (conv: ConvId, deviceId: string, cursor: { read: string; ingested: string }) => void
  onDropHint?: (fromDeviceId: string) => void
  onXfers?: (deviceId: string, xfers: NonNullable<BeaconContent['xfers']>) => void
  onHealthChange?: (reachable: boolean) => void
  onNewDevice?: () => void
  /** A verified beacon named the Chat build behind it (1.2+ writers only). */
  onPeerVersion?: (version: string, name: string) => void
}

export class Poller {
  private reader: BeaconReader
  private observations = new Map<string, DeviceObservation>() // full deviceId
  private timer: NodeJS.Timeout | null = null
  private ticks = 0
  private polled = false // first beacon listing done: absence now means something
  private running = false
  private degraded = false
  listeners: PollerEvents = {}
  /** I/O tier (1.2) — drives both the tick and the blanket-sweep cadence. */
  private tier: IoTier = 'blurred'
  /**
   * Current tick period. Derived from the tier, never from POLL.defaultMs: a
   * client that launches unfocused never gets a setTier('blurred') (it is
   * already there and setTier early-returns), so a default of defaultMs meant
   * it polled at 1.5 s for the rest of its life.
   */
  intervalMs: number = tickMsFor(this.tier) ?? POLL.defaultMs
  /** Share clock of the last blanket sweep; 0 = sweep on the next tick. */
  private lastSweepAt = 0
  private kick: (() => void) | null = null
  /**
   * Which loop chain is allowed to reschedule. A tier speed-up starts a fresh
   * chain; any tick still in flight from the previous one carries an older id
   * and bows out instead of scheduling a second, parallel wake-up.
   */
  private chain = 0

  constructor(
    private session: Session,
    private events: EventStore,
  ) {
    this.reader = new BeaconReader(session)
  }

  start(): void {
    this.running = true
    this.intervalMs = tickMsFor(this.tier) ?? this.intervalMs
    // Sweep on the very first tick. ChatService.start() has just caught every
    // conversation up, but channel *discovery* lives inside the sweep, so
    // deferring it a whole period means a channel created while we were away
    // (or one whose first event nobody has beaconed) stays invisible for one
    // to ten minutes after launch.
    this.lastSweepAt = 0
    const loop = async (id: number): Promise<void> => {
      if (!this.running || this.isPaused() || id !== this.chain) return
      const t0 = Date.now()
      try {
        await this.tick()
      } catch {
        // tick errors surface through share health
      }
      // Re-checked after the await: a lock-screen during a slow tick must not
      // schedule one more wake-up, and neither must a tick whose chain was
      // superseded by a speed-up while it was in flight.
      if (!this.running || this.isPaused() || id !== this.chain) return
      const elapsed = Date.now() - t0
      this.timer = setTimeout(() => void loop(id), Math.max(200, this.intervalMs - elapsed))
    }
    this.kick = () => {
      const id = ++this.chain
      void loop(id)
    }
    this.kick()
  }

  stop(): void {
    this.running = false
    this.chain++ // any tick still in flight loses its claim to reschedule
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * Move to an I/O tier: `paused` (screen locked / machine suspended) stops the
   * loop dead, anything else sets the cadence and — when we are speeding up or
   * coming back from paused — ticks once right away so the window is never
   * showing a stale room for a whole idle interval.
   */
  setTier(tier: IoTier): void {
    const prev = this.tier
    if (tier === prev) return
    this.tier = tier
    const next = tickMsFor(tier)
    if (next === null) {
      // paused: the running loop returns on its own, but a scheduled wake-up
      // would still fire once — drop it.
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      return
    }
    const faster = next < this.intervalMs
    this.intervalMs = next
    if (!this.running) return
    if (prev === 'paused' || faster) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      this.kick?.()
    }
  }

  private isPaused(): boolean {
    return this.tier === 'paused'
  }

  /** Milliseconds between blanket catch-up sweeps at the current tier. */
  private sweepMs(): number | null {
    return sweepMsFor(this.tier)
  }

  async tick(): Promise<void> {
    const s = this.session
    this.ticks++

    // Degraded-mode detection & recovery
    if (this.degraded) {
      const back = await s.io.probe()
      if (!back) return
      this.degraded = false
      this.listeners.onHealthChange?.(true)
    }

    let observations: BeaconObservation[]
    try {
      observations = await this.reader.poll()
    } catch {
      if (!this.degraded) {
        this.degraded = true
        this.listeners.onHealthChange?.(false)
      }
      return
    }
    const firstPoll = !this.polled

    for (const obs of observations) {
      await this.processObservation(obs)
    }
    // Only now: processObservation pushes presence for every device it meets,
    // and until the whole listing is in, everyone not reached yet still looks
    // like they have no beacon at all — i.e. departed. Flip the guard after.
    this.polled = true

    // Channel discovery + a full catch-up sweep on a slower cadence (new
    // channels, day rollover, events from devices whose beacons we missed).
    // Wall-clock driven since 1.2, so the tick rate and the sweep rate are
    // independent: 1/3/10 minutes for focused/blurred/idle.
    const sweepMs = this.sweepMs()
    if (sweepMs !== null && Date.now() - this.lastSweepAt >= sweepMs) {
      this.lastSweepAt = Date.now()
      const before = s.channels.size
      await s.loadChannels()
      if (s.channels.size !== before) this.listeners.onNewDevice?.()
      // `fast` opens today's day directory by name instead of listing the day
      // directories first — half the readdirs per conversation, and it lapses
      // back to the full walk by itself at the day rollover (see catchUp).
      const sweep = { fast: true } as const
      for (const ch of s.activeChannels()) {
        await this.events.catchUp(s.convIdForChannel(ch.channelId), sweep)
      }
      for (const dm of s.dms.values()) {
        await this.events.catchUp(`dm:${dm.pairToken}`, sweep)
      }
      // Team logs (calendar, PR config) have no discovery step — their ids are
      // fixed, so the sweep just catches each one up.
      for (const conv of Object.values(TEAM_CONV)) {
        await this.events.catchUp(conv, sweep)
      }
      // Private groups (1.2): no discovery either — the invite brought the key,
      // and the sweep picks up anything the beacon heads missed.
      for (const conv of s.groups?.convs() ?? []) {
        await this.events.catchUp(conv, sweep)
      }
    }

    // Silence is a state change too (online → away → offline with nobody
    // else's beacon to prompt a refresh), so re-derive on a slow cadence.
    if (observations.length > 0 || firstPoll || this.ticks % 10 === 0) this.emitPresence()
  }

  private async processObservation(obs: BeaconObservation): Promise<void> {
    const s = this.session
    const deviceId = obs.content.device
    const known = this.observations.has(deviceId)
    this.observations.set(deviceId, { content: obs.content, verified: obs.verified })
    if (!known) this.listeners.onNewDevice?.()
    if (!obs.verified) return // unverified beacons never drive ingestion

    // A teammate on a newer build (1.2+). Unverified beacons are excluded on
    // purpose: an update banner must not be raisable by anyone who can write
    // to the share. The listener dedupes per version.
    if (obs.content.app) this.listeners.onPeerVersion?.(obs.content.app, obs.content.name)

    // Channel + team heads → ingest the exact new event files. Only channels
    // need a discovery refresh; team conv ids are fixed and always derivable.
    for (const [conv, heads] of Object.entries(obs.content.heads ?? {})) {
      if (!isChanConv(conv) && !isTeamConv(conv)) continue
      if (isChanConv(conv) && !s.channels.get(conv.slice(5))) await s.loadChannels()
      // A tombstoned channel is closed: don't re-read a log on its way out.
      if (isChanConv(conv) && s.channels.get(conv.slice(5))?.deletedAt) continue
      await this.events.ingestHeads(conv as ConvId, heads)
    }
    // Channel cursors → delivery/read receipts
    for (const [conv, cursor] of Object.entries(obs.content.cursors ?? {})) {
      this.listeners.onCursors?.(conv as ConvId, deviceId, cursor)
    }
    // Sealed sections: DM pairs that involve us, plus private groups we hold a
    // key for (1.2) — same treatment, the reader already did the decrypting.
    const sealed: [ConvId, DmBeaconSection][] = [...obs.dmSections].map(([token, section]) => [
      `dm:${token}` as ConvId,
      section,
    ])
    for (const [token, section] of obs.grpSections ?? []) {
      const conv = s.groups?.convForToken(token)
      if (conv) sealed.push([conv, section])
    }
    for (const [conv, section] of sealed) {
      if (section.heads.length) await this.events.ingestHeads(conv, section.heads)
      // Private-group notices in a DM (1.2) travel in their own ring, out of
      // `heads`, so that a 1.1 peer reading the same section never meets a
      // filename it cannot parse. Same ingestion, one field over.
      if (section.grpHeads?.length) await this.events.ingestHeads(conv, section.grpHeads)
      this.listeners.onCursors?.(conv, deviceId, section.cursor)
      if (section.typingUntil && section.typingUntil > s.io.calibratedNow()) {
        this.listeners.onTyping?.(conv, deviceId, section.typingUntil)
      }
    }
    // Channel typing
    if (obs.content.typing && obs.content.typing.until > s.io.calibratedNow()) {
      this.listeners.onTyping?.(obs.content.typing.conv, deviceId, obs.content.typing.until)
    }
    // Drop hints addressed to us
    if (obs.content.drops?.[s.deviceId]) {
      this.listeners.onDropHint?.(deviceId)
    }
    if (obs.content.xfers) this.listeners.onXfers?.(deviceId, obs.content.xfers)
  }

  // -------------------------------------------------------------------------
  // Presence

  presenceViews(): PresenceView[] {
    const s = this.session
    const shareNow = s.io.calibratedNow()
    const entries = s.roster.all().filter((e) => e.record.deviceId !== s.deviceId)
    const views: PresenceView[] = []

    for (const entry of entries) {
      const deviceId = entry.record.deviceId
      const obs = this.observations.get(deviceId)
      let state: PresenceStateKind = 'offline'
      let lastSeenMs: number | null = null
      let status = ''
      if (obs) {
        // The beacon's own stamp, not when we noticed it: a device that quit
        // last week reads as "last week" even on a fresh launch.
        lastSeenMs = Math.min(obs.content.hlc, shareNow)
        status = obs.content.presence.status
        // Freshness comes from that same stamp, not from when this reader got
        // round to reading the file. Measuring from the observation made the
        // answer depend on our own tick rate (a 45–48 s idle heartbeat has only
        // 2 s of slack inside PRESENCE.onlineWithinMs, and an idle reader's poll
        // delay is 15 s), and it let a beacon written hours ago read as "online"
        // for a whole minute after a cold start or a resume from a locked screen.
        const age = Math.max(0, shareNow - lastSeenMs)
        if (obs.content.presence.state === 'offline') state = 'offline'
        else if (age < PRESENCE.onlineWithinMs) {
          state = obs.content.presence.idleSec >= PRESENCE.awayIdleSec ? 'away' : 'online'
        } else if (age < PRESENCE.offlineAfterMs) state = 'away'
        else state = 'offline'
      }
      // Departed devices stay in the list (flagged) so their old messages
      // keep a name and an unread DM from them still has a row to open.
      const departed = state === 'offline' && this.departed(entry, lastSeenMs, shareNow, entries)
      views.push({
        deviceId,
        name: obs?.content.name ?? entry.pin.displayName,
        hostname: sanitizeHostname(entry.record.hostname),
        fingerprint: fingerprintFromEdPub(entry.pin.edPub),
        state,
        status,
        lastSeenMs,
        trust: entry.pin.trust,
        dmConv: `dm:${s.dmFor(deviceId)?.pairToken ?? ''}`,
        // Same gate as onPeerVersion: a build number nobody signed for is not
        // evidence, and it is what the update banner reads.
        app: obs?.verified ? obs.content.app : undefined,
        departed,
      })
    }
    return views
  }

  /**
   * A registration nobody is behind any more: no beacon at all (the janitor
   * swept it, or the device never came back after a reset), quiet for longer
   * than a long weekend, or plainly superseded — the same person on the same
   * machine set up again, so this identity will never sign anything again.
   * Only a hide: the roster entry stays, so its old messages still verify and
   * the row is back the moment the device is.
   */
  private departed(entry: RosterEntry, lastSeenMs: number | null, shareNow: number, all: RosterEntry[]): boolean {
    if (!this.polled) return false // before the first listing, absence means nothing yet
    if (lastSeenMs === null) return true
    if (shareNow - lastSeenMs > PRESENCE.departedAfterMs) return true
    const r = entry.record
    return all.some(
      (o) =>
        o !== entry &&
        o.record.firstSeen > r.firstSeen &&
        o.record.displayName === r.displayName &&
        sanitizeHostname(o.record.hostname) === sanitizeHostname(r.hostname) &&
        (!o.record.machineIdHash || !r.machineIdHash || o.record.machineIdHash === r.machineIdHash),
    )
  }

  private emitPresence(): void {
    this.listeners.onPresence?.(this.presenceViews())
  }

  getObservation(deviceId: string): { content: BeaconContent; verified: boolean } | null {
    const o = this.observations.get(deviceId)
    return o ? { content: o.content, verified: o.verified } : null
  }
}
