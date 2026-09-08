import { BEACON, DIR, DST, KID } from '@shared/constants'
import { beaconFileName, parseBeaconFileName, seqToBase36 } from '@shared/ids'
import type { BeaconContent, ConvId, DmBeaconSection, SignedRecord } from '@shared/types'
import { buildAad, decryptRecord, encryptRecord } from '../crypto/envelope'
import { signRecord, verifyRecord } from '../crypto/identity'
import type { Session } from './session'

// The beacon: one single-writer file per device whose SEQUENCE lives in the
// filename, so one readdir of beacon/ per poll tick reveals every device's
// latest state with zero stat calls. Contents carry presence, typing, heads
// (exact filenames of recent events), cursors, transfer progress, drop hints,
// and LAN reachability. DM-related state is nested and encrypted per-pair so
// teammates can't map who talks to whom.

export class BeaconWriter {
  private seq: number
  private lastPublishedName: string | null = null
  private dirty = false
  private pendingTimer: NodeJS.Timeout | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private lastBumpAt = 0

  // State assembled into each beacon
  presence: BeaconContent['presence'] = { state: 'online', status: '', idleSec: 0 }
  typing: BeaconContent['typing'] | undefined
  private heads = new Map<ConvId, string[]>() // channels only
  private cursors = new Map<ConvId, { read: string; ingested: string }>()
  private dmSections = new Map<string, DmBeaconSection>() // pairToken -> section
  xfers: BeaconContent['xfers'] = {}
  drops: BeaconContent['drops'] = {}
  lanIps: string[] = []
  wsPort: number | undefined

  constructor(private session: Session) {
    this.seq = session.store.readSecretJson<number>('beacon-seq') ?? 0
  }

  start(): void {
    this.heartbeat = setInterval(
      () => void this.bump('heartbeat'),
      BEACON.heartbeatMs + Math.floor(Math.random() * 2 - 1) * BEACON.heartbeatJitterMs,
    )
    void this.bump('startup')
  }

  async stop(goodbye = true): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.pendingTimer) clearTimeout(this.pendingTimer)
    if (goodbye) {
      this.presence = { ...this.presence, state: 'offline' }
      await this.publishNow().catch(() => {})
    }
  }

  noteOwnEvent(conv: ConvId, fileName: string): void {
    if (conv.startsWith('chan:')) {
      const ring = this.heads.get(conv) ?? []
      ring.push(fileName)
      while (ring.length > BEACON.headsRingSize) ring.shift()
      this.heads.set(conv, ring)
    } else {
      const token = conv.slice(3)
      const section = this.dmSections.get(token) ?? { heads: [], cursor: { read: '', ingested: '' } }
      section.heads.push(fileName)
      while (section.heads.length > BEACON.headsRingSize) section.heads.shift()
      this.dmSections.set(token, section)
    }
    void this.bump('event')
  }

  setCursor(conv: ConvId, cursor: { read: string; ingested: string }): void {
    if (conv.startsWith('chan:')) {
      const prev = this.cursors.get(conv)
      if (prev && prev.read === cursor.read && prev.ingested === cursor.ingested) return
      this.cursors.set(conv, cursor)
    } else {
      const token = conv.slice(3)
      const section = this.dmSections.get(token) ?? { heads: [], cursor: { read: '', ingested: '' } }
      if (section.cursor.read === cursor.read && section.cursor.ingested === cursor.ingested) return
      section.cursor = cursor
      this.dmSections.set(token, section)
    }
    void this.bump('cursor')
  }

  setTyping(conv: ConvId | null): void {
    const until = this.session.io.calibratedNow() + BEACON.typingTtlMs
    if (conv && conv.startsWith('dm:')) {
      const token = conv.slice(3)
      const section = this.dmSections.get(token) ?? { heads: [], cursor: { read: '', ingested: '' } }
      section.typingUntil = until
      this.dmSections.set(token, section)
      void this.bump('typing')
      return
    }
    this.typing = conv ? { conv, until } : undefined
    void this.bump('typing')
  }

  setPresence(p: Partial<BeaconContent['presence']>): void {
    this.presence = { ...this.presence, ...p }
    void this.bump('presence')
  }

  noteDropHint(recipientDeviceId: string): void {
    this.drops = { ...this.drops, [recipientDeviceId]: this.session.io.calibratedNow() }
    void this.bump('event')
  }

  setXfer(blobId: string, progress: { done: number; total: number } | null): void {
    const x = { ...(this.xfers ?? {}) }
    if (progress) x[blobId] = progress
    else delete x[blobId]
    this.xfers = x
    void this.bump('cursor') // coalesced cadence is fine for progress
  }

  /** Coalesced bump: events/typing go fast, cursors coalesce. */
  async bump(reason: 'startup' | 'heartbeat' | 'event' | 'typing' | 'cursor' | 'presence'): Promise<void> {
    this.dirty = true
    const now = Date.now()
    const minGap = reason === 'cursor' ? BEACON.cursorCoalesceMs : reason === 'typing' ? BEACON.typingBumpMinMs : 0
    const wait = Math.max(0, this.lastBumpAt + minGap - now)
    if (wait === 0) {
      await this.publishNow().catch(() => {})
    } else if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null
        void this.publishNow().catch(() => {})
      }, wait)
    }
  }

  private async publishNow(): Promise<void> {
    if (!this.dirty && this.lastPublishedName) {
      // Heartbeats still rewrite (freshness is the signal), so fall through.
    }
    this.dirty = false
    this.lastBumpAt = Date.now()
    const s = this.session
    this.seq += 1
    s.store.writeSecretJson('beacon-seq', this.seq)
    const name = beaconFileName(s.deviceId, this.seq)
    const seq36 = seqToBase36(this.seq)

    // Seal DM sections per pair
    const dmSealed: Record<string, string> = {}
    for (const [token, section] of this.dmSections) {
      const dm = s.dmsByToken.get(token)
      if (!dm) continue
      const aad = buildAad('dmb', `${token}/${s.deviceId8}`, seq36)
      dmSealed[token] = encryptRecord(dm.key, KID.dm(token), Buffer.from(JSON.stringify(section)), aad).toString('base64')
    }

    const content: BeaconContent = {
      device: s.deviceId,
      name: s.displayName,
      seq: seq36,
      hlc: s.io.calibratedNow(),
      presence: this.presence,
      typing: this.typing && this.typing.until > s.io.calibratedNow() ? this.typing : undefined,
      heads: Object.fromEntries(this.heads),
      cursors: Object.fromEntries(this.cursors),
      dmSealed: Object.keys(dmSealed).length ? dmSealed : undefined,
      xfers: this.xfers && Object.keys(this.xfers).length ? this.xfers : undefined,
      drops: this.drops && Object.keys(this.drops).length ? this.drops : undefined,
      lanIps: this.lanIps.length ? this.lanIps : undefined,
      p2p: this.wsPort ? { caps: ['rtc-v1'], wsPort: this.wsPort } : undefined,
    }

    const signed = signRecord(s.identity, DST.record, content)
    const rel = `${DIR.beacon}/${name}`
    const aad = buildAad('pres', rel, s.deviceId8)
    await s.io.publish(rel, encryptRecord(s.keys.kPres, KID.pres(s.proto.epoch), Buffer.from(JSON.stringify(signed)), aad), {
      calibrate: true,
    })
    const old = this.lastPublishedName
    this.lastPublishedName = name
    if (old && old !== name) await s.io.delete(`${DIR.beacon}/${old}`).catch(() => {})
  }
}

// ---------------------------------------------------------------------------

export interface BeaconObservation {
  deviceId8: string
  content: BeaconContent
  verified: boolean
  dmSections: Map<string, DmBeaconSection> // pairToken -> decrypted section (ours only)
  observedAtMono: number
}

export class BeaconReader {
  private lastSeqs = new Map<string, number>() // id8 -> seq

  constructor(private session: Session) {}

  /** One poll tick: single readdir; reads only changed beacons. */
  async poll(): Promise<BeaconObservation[]> {
    const s = this.session
    const names = await s.io.list(DIR.beacon)
    const best = new Map<string, { seq: number; name: string }>()
    for (const n of names) {
      const p = parseBeaconFileName(n)
      if (!p) continue
      const cur = best.get(p.deviceId8)
      if (!cur || p.seq > cur.seq) best.set(p.deviceId8, { seq: p.seq, name: n })
    }

    const out: BeaconObservation[] = []
    for (const [id8, { seq, name }] of best) {
      if (id8 === s.deviceId8) continue
      if ((this.lastSeqs.get(id8) ?? -1) >= seq) continue
      const obs = await this.readOne(id8, name)
      if (obs) {
        this.lastSeqs.set(id8, seq)
        out.push(obs)
      }
    }
    return out
  }

  private async readOne(id8: string, name: string): Promise<BeaconObservation | null> {
    const s = this.session
    const rel = `${DIR.beacon}/${name}`
    const buf = await s.io.readMaybe(rel)
    if (!buf) return null
    try {
      const aad = buildAad('pres', rel, id8)
      const plain = decryptRecord(buf, s.keys.kPres, aad)
      const signed = JSON.parse(plain.toString('utf8')) as SignedRecord<BeaconContent>
      let author = s.roster.get(signed.by)
      if (!author) {
        author = (await s.roster.loadOne(signed.by)) ?? undefined
        if (author) s.refreshDms()
      }
      const verified = !!author && verifyRecord(signed, DST.record, author.edPubKey)
      if (!signed.by.startsWith(id8)) return null

      const dmSections = new Map<string, DmBeaconSection>()
      if (signed.p.dmSealed) {
        for (const [token, b64] of Object.entries(signed.p.dmSealed)) {
          const dm = s.dmsByToken.get(token)
          if (!dm) continue // not our pair — unreadable by design
          try {
            const sAad = buildAad('dmb', `${token}/${id8}`, signed.p.seq)
            const sec = JSON.parse(decryptRecord(Buffer.from(b64, 'base64'), dm.key, sAad).toString('utf8'))
            dmSections.set(token, sec as DmBeaconSection)
          } catch {
            // skip broken section
          }
        }
      }

      return { deviceId8: id8, content: signed.p, verified, dmSections, observedAtMono: Date.now() }
    } catch {
      return null
    }
  }
}
