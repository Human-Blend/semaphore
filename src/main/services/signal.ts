import { DIR, DST, KID, POLL } from '@shared/constants'
import { parseSignalFileName, signalFileName } from '@shared/ids'
import type { PushMessage } from '@shared/bridge'
import type { RtcSignal, SignedRecord } from '@shared/types'
import { buildAad, openSealedRecord, sealRecord } from '../crypto/envelope'
import { importX25519Pub } from '../crypto/envelope'
import { signRecord, verifyRecord } from '../crypto/identity'
import type { Session } from '../transport/session'

// WebRTC signaling over the shared folder: one-shot files, sealed to the
// addressee, Ed25519-signed by the sender, routed by filename so foreign
// signals cost zero reads. The addressee deletes a file after processing.

export class SignalService {
  private timer: NodeJS.Timeout | null = null
  private mode: 'fast' | 'idle' = 'idle'
  private seq = 0
  private seen = new Set<string>()

  constructor(
    private session: Session,
    private push: (msg: PushMessage) => void,
  ) {}

  start(): void {
    this.schedule()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
  }

  setPollMode(mode: 'fast' | 'idle'): void {
    if (this.mode === mode) return
    this.mode = mode
    if (this.timer) clearTimeout(this.timer)
    this.schedule()
  }

  private schedule(): void {
    const interval = this.mode === 'fast' ? POLL.rtcFastMs : POLL.defaultMs * 2
    this.timer = setTimeout(async () => {
      try {
        await this.poll()
      } catch {
        // share hiccups surface via health elsewhere
      }
      this.schedule()
    }, interval)
  }

  async send(signal: RtcSignal): Promise<void> {
    const s = this.session
    const recipient = s.roster.get(signal.to)
    if (!recipient) throw new Error('unknown recipient device')
    const signed = signRecord(s.identity, DST.rtc, signal)
    const name = signalFileName(
      s.io.calibratedNow(),
      signal.sessionId,
      this.seq++,
      s.deviceId,
      signal.to,
      signal.signal,
    )
    const rel = `${DIR.rtc}/${name}`
    // AAD binds to the 8-hex session prefix that the filename carries — the
    // reader reconstructs the same value from the name alone.
    const aad = buildAad('rtc', rel, signal.sessionId.slice(0, 8))
    const buf = sealRecord(
      importX25519Pub(recipient.pin.xPub),
      KID.seal(signal.to),
      Buffer.from(JSON.stringify(signed)),
      aad,
    )
    await s.io.publish(rel, buf)
  }

  private async poll(): Promise<void> {
    const s = this.session
    const names = await s.io.list(DIR.rtc)
    for (const name of names) {
      if (name === '.tmp' || this.seen.has(name)) continue
      const parsed = parseSignalFileName(name)
      if (!parsed) continue
      if (parsed.to8 !== s.deviceId8) continue // not addressed to us — zero reads
      this.seen.add(name)
      const rel = `${DIR.rtc}/${name}`
      const buf = await s.io.readMaybe(rel)
      if (!buf) continue
      try {
        const plain = openSealedRecord(buf, s.identity.xPriv, buildAadForName(rel, name))
        const signed = JSON.parse(plain.toString('utf8')) as SignedRecord<RtcSignal>
        const author = s.roster.get(signed.by) ?? (await s.roster.loadOne(signed.by))
        if (!author || !verifyRecord(signed, DST.rtc, author.edPubKey)) continue
        if (!signed.by.startsWith(parsed.from8)) continue
        this.push({ kind: 'rtc-signal', signal: signed.p })
      } catch {
        // not for us / corrupt — leave for the janitor
      } finally {
        await s.io.delete(rel).catch(() => {})
      }
    }
    // Bound the memory of the seen set
    if (this.seen.size > 2000) this.seen.clear()
  }
}

/** AAD for signal files uses the 8-hex session prefix from the filename. */
function buildAadForName(rel: string, name: string): Buffer {
  const sess8 = parseSignalFileName(name)?.sess8 ?? ''
  return buildAad('rtc', rel, sess8)
}
