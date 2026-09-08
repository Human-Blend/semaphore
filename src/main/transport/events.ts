import { DST, EVENT } from '@shared/constants'
import { hlcObserve, hlcTick } from '@shared/hlc'
import { dayShard, eventFileName, parseEventFileName } from '@shared/ids'
import type { ConvId, EventPayload, EventType, SignedRecord, VerifiedEvent } from '@shared/types'
import { buildAad, decryptRecord, encryptRecord } from '../crypto/envelope'
import { signRecord, verifyRecord } from '../crypto/identity'
import type { Session } from './session'

// Append-only event logs, one encrypted file per event. The filename stem is
// the event id and total order. Publishing also ratchets the HLC; ingesting a
// remote event folds its timestamp into our clock.

interface ConvLog {
  events: Map<string, VerifiedEvent>
  /** Days already fully scanned (catch-up bookkeeping). */
  scannedDays: Set<string>
  newestStem: string | null
}

export type EventListener = (conv: ConvId, event: VerifiedEvent) => void

export class EventStore {
  private logs = new Map<ConvId, ConvLog>()
  private listeners: EventListener[] = []
  /** Sticky skew flags per device (UI banner). */
  readonly skewFlagged = new Set<string>()

  constructor(private session: Session) {}

  onEvent(cb: EventListener): void {
    this.listeners.push(cb)
  }

  private log(conv: ConvId): ConvLog {
    let l = this.logs.get(conv)
    if (!l) this.logs.set(conv, (l = { events: new Map(), scannedDays: new Set(), newestStem: null }))
    return l
  }

  getEvents(conv: ConvId): VerifiedEvent[] {
    return [...this.log(conv).events.values()]
  }

  has(conv: ConvId, stem: string): boolean {
    return this.log(conv).events.has(stem)
  }

  newestStem(conv: ConvId): string | null {
    return this.log(conv).newestStem
  }

  // -------------------------------------------------------------------------

  async publish(conv: ConvId, type: EventType, payload: EventPayload): Promise<VerifiedEvent> {
    const s = this.session
    const info = s.convInfo(conv)
    if (!info) throw new Error(`unknown conversation ${conv}`)
    const { ms, ctr } = hlcTick(s.hlc, s.io.calibratedNow())
    const fileName = eventFileName(ms, ctr, s.deviceId, type)
    const stem = fileName.slice(0, fileName.indexOf('.'))
    const day = dayShard(ms)
    const rel = `${info.eventsDir}/${day}/${fileName}`

    const signed = signRecord(s.identity, DST.record, payload)
    const plain = Buffer.from(JSON.stringify(signed), 'utf8')
    if (plain.length > EVENT.maxFileBytes) throw new Error('event too large — use the blob store')
    const aad = buildAad(info.scope, rel, stem)
    const buf = encryptRecord(info.key, info.kid, plain, aad)
    await s.io.publish(rel, buf, { calibrate: true })

    const ev: VerifiedEvent = {
      id: stem,
      type,
      payload,
      author: s.deviceId,
      verified: true,
      receivedAt: Date.now(),
    }
    this.insert(conv, ev)
    return ev
  }

  // -------------------------------------------------------------------------

  /** Ingest one event file by name (from a beacon head or a day scan). */
  async ingestFile(conv: ConvId, day: string, fileName: string): Promise<VerifiedEvent | null> {
    const parsed = parseEventFileName(fileName)
    if (!parsed) return null
    const l = this.log(conv)
    if (l.events.has(parsed.stem)) return l.events.get(parsed.stem)!

    const s = this.session
    const info = s.convInfo(conv)
    if (!info) return null
    const rel = `${info.eventsDir}/${day}/${fileName}`
    const buf = await s.io.readMaybe(rel)
    if (!buf) return null

    try {
      const aad = buildAad(info.scope, rel, parsed.stem)
      const plain = decryptRecord(buf, info.key, aad)
      const signed = JSON.parse(plain.toString('utf8')) as SignedRecord<EventPayload>

      let author = s.roster.get(signed.by)
      if (!author) {
        author = (await s.roster.loadOne(signed.by)) ?? undefined
        if (author) s.refreshDms()
      }
      const verified = !!author && verifyRecord(signed, DST.record, author.edPubKey)
      // The filename's device prefix must match the signer — otherwise someone
      // is replaying another author's payload under their own slot.
      if (!signed.by.startsWith(parsed.deviceId8)) return null

      const skewed = hlcObserve(s.hlc, parsed.hlcMs, s.io.calibratedNow())
      if (skewed) this.skewFlagged.add(signed.by)

      const ev: VerifiedEvent = {
        id: parsed.stem,
        type: parsed.type,
        payload: signed.p,
        author: signed.by,
        verified,
        receivedAt: Date.now(),
      }
      this.insert(conv, ev)
      return ev
    } catch {
      return null // auth failure / corrupt — quarantine by skipping
    }
  }

  /**
   * Scan a conversation's day directories and ingest everything missing.
   * Closed days that were fully scanned once are skipped forever.
   */
  async catchUp(conv: ConvId): Promise<number> {
    const s = this.session
    const info = s.convInfo(conv)
    if (!info) return 0
    const l = this.log(conv)
    const days = (await s.io.listDirs(info.eventsDir)).sort()
    const today = dayShard(s.io.calibratedNow())
    let ingested = 0
    for (const day of days) {
      if (l.scannedDays.has(day) && day < today) continue
      const files = await s.io.list(`${info.eventsDir}/${day}`)
      for (const f of files.sort()) {
        const before = l.events.size
        await this.ingestFile(conv, day, f)
        if (l.events.size > before) ingested++
      }
      if (day < today) l.scannedDays.add(day)
    }
    return ingested
  }

  /** Ingest the exact files a peer's beacon `heads` names (zero readdirs). */
  async ingestHeads(conv: ConvId, headFileNames: string[]): Promise<boolean> {
    let sawNew = false
    let mayHaveGap = false
    const l = this.log(conv)
    for (const f of headFileNames) {
      const parsed = parseEventFileName(f)
      if (!parsed) continue
      if (l.events.has(parsed.stem)) continue
      const ev = await this.ingestFile(conv, dayShard(parsed.hlcMs), f)
      if (ev) sawNew = true
      else mayHaveGap = true
    }
    // If the oldest advertised head is still missing, older un-advertised
    // events may exist too — fall back to a bounded day scan.
    if (mayHaveGap) await this.catchUp(conv)
    return sawNew
  }

  private insert(conv: ConvId, ev: VerifiedEvent): void {
    const l = this.log(conv)
    l.events.set(ev.id, ev)
    if (!l.newestStem || ev.id > l.newestStem) l.newestStem = ev.id
    for (const cb of this.listeners) cb(conv, ev)
  }
}
