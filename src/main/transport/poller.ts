import { POLL, PRESENCE, TEAM_CONV } from '@shared/constants'
import type { BeaconContent, ConvId, PresenceStateKind, PresenceView } from '@shared/types'
import { fingerprintFromEdPub } from '../crypto/identity'
import { isChanConv, isTeamConv, sanitizeHostname } from '@shared/ids'
import { BeaconReader, type BeaconObservation } from './beacon'
import type { EventStore } from './events'
import type { RosterEntry } from './roster'
import type { Session } from './session'

// Drives the whole read side: beacon polling, event ingestion via heads,
// channel discovery, presence derivation, typing, and remote cursors.

interface DeviceObservation {
  content: BeaconContent
  verified: boolean
  lastSeqChangeMono: number
}

export interface PollerEvents {
  onPresence?: (views: PresenceView[]) => void
  onTyping?: (conv: ConvId, deviceId: string, until: number) => void
  onCursors?: (conv: ConvId, deviceId: string, cursor: { read: string; ingested: string }) => void
  onDropHint?: (fromDeviceId: string) => void
  onXfers?: (deviceId: string, xfers: NonNullable<BeaconContent['xfers']>) => void
  onHealthChange?: (reachable: boolean) => void
  onNewDevice?: () => void
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
  intervalMs: number = POLL.defaultMs

  constructor(
    private session: Session,
    private events: EventStore,
  ) {
    this.reader = new BeaconReader(session)
  }

  start(): void {
    this.running = true
    const loop = async () => {
      if (!this.running) return
      const t0 = Date.now()
      try {
        await this.tick()
      } catch {
        // tick errors surface through share health
      }
      const elapsed = Date.now() - t0
      this.timer = setTimeout(loop, Math.max(200, this.intervalMs - elapsed))
    }
    void loop()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
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
    if (this.ticks % 20 === 1) {
      const before = s.channels.size
      await s.loadChannels()
      if (s.channels.size !== before) this.listeners.onNewDevice?.()
      for (const ch of s.channels.values()) {
        await this.events.catchUp(s.convIdForChannel(ch.channelId))
      }
      for (const dm of s.dms.values()) {
        await this.events.catchUp(`dm:${dm.pairToken}`)
      }
      // Team logs (calendar, PR config) have no discovery step — their ids are
      // fixed, so the sweep just catches each one up.
      for (const conv of Object.values(TEAM_CONV)) {
        await this.events.catchUp(conv)
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
    this.observations.set(deviceId, {
      content: obs.content,
      verified: obs.verified,
      lastSeqChangeMono: obs.observedAtMono,
    })
    if (!known) this.listeners.onNewDevice?.()
    if (!obs.verified) return // unverified beacons never drive ingestion

    // Channel + team heads → ingest the exact new event files. Only channels
    // need a discovery refresh; team conv ids are fixed and always derivable.
    for (const [conv, heads] of Object.entries(obs.content.heads ?? {})) {
      if (!isChanConv(conv) && !isTeamConv(conv)) continue
      if (isChanConv(conv) && !s.channels.get(conv.slice(5))) await s.loadChannels()
      await this.events.ingestHeads(conv as ConvId, heads)
    }
    // Channel cursors → delivery/read receipts
    for (const [conv, cursor] of Object.entries(obs.content.cursors ?? {})) {
      this.listeners.onCursors?.(conv as ConvId, deviceId, cursor)
    }
    // DM sections (only pairs that involve us decrypt)
    for (const [token, section] of obs.dmSections) {
      const conv: ConvId = `dm:${token}`
      if (section.heads.length) await this.events.ingestHeads(conv, section.heads)
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
    const now = Date.now()
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
        const age = now - obs.lastSeqChangeMono
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
