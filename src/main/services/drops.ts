import { app, Notification, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { BeamProgressView, PushMessage, SettingsView } from '@shared/bridge'
import type { DropAck, DropOffer, SysPayload } from '@shared/types'
import { APP, DIR, DROP, FILE_EXT, KID } from '@shared/constants'
import { buildAad, importX25519Pub, openSealedRecord, sealRecord } from '../crypto/envelope'
import type { Session } from '../transport/session'
import type { ShareIo } from '../transport/shareIo'
import { decryptSfb1File, encryptFileToShare, mimeForName, sanitizeFileName } from './blobs'
import type { ChatService } from './chatService'

// AirDrop-style direct beams over the drops/ inbox (folder transport, v1 — no
// P2P). File layout under drops/<recipientDeviceId>/:
//   <dropId>.blob      SFB1-encrypted file under a random per-drop key,
//                      baseAad = buildAad('drop', <blob relpath>, dropId)
//   <dropId>.offer.e1  SFC1 sealed to the RECIPIENT's xPub (kid seal/<rcpt8>),
//                      aad = buildAad('drop', <offer relpath>, dropId);
//                      plaintext = JSON DropOffer (carries the blobKey)
//   <dropId>.ack.e1    SFC1 sealed by the RECIPIENT to the SENDER's xPub,
//                      aad = buildAad('drop-ack', <ack relpath>, dropId);
//                      plaintext = JSON DropAck — single-writer (recipient),
//                      overwritten in place as state advances
// dropId = <calibratedNow>-<senderId8>-<rand4hex>.
// Cleanup contract: recipient deletes blob+offer after saving/declining;
// sender deletes the ack once it has seen the terminal state.

const ACK_POLL_MS = 2_000
const INBOX_POLL_MS = 30_000

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

async function uniquePath(p: string): Promise<string> {
  const dir = dirname(p)
  const ext = extname(p)
  const stem = basename(p, ext)
  let candidate = p
  for (let i = 2; i < 1000; i++) {
    try {
      await stat(candidate)
    } catch {
      return candidate // ENOENT — free
    }
    candidate = join(dir, `${stem} (${i})${ext}`)
  }
  return join(dir, `${stem}-${randomBytes(3).toString('hex')}${ext}`)
}

interface ActiveSend {
  dropId: string
  peer: string
  name: string
  size: number
  startedAt: number
  timer: NodeJS.Timeout | null
  done: boolean
  polling: boolean
}

interface IncomingOffer {
  offer: DropOffer
  busy: boolean
}

export class DropService {
  private sends = new Map<string, ActiveSend>()
  private incoming = new Map<string, IncomingOffer>()
  /** Terminally handled dropIds — never re-offered within this session. */
  private handled = new Set<string>()
  private scanTimer: NodeJS.Timeout | null = null
  private scanning = false
  private scanQueued = false
  private stopped = false

  constructor(
    private chat: ChatService,
    private getWindow: () => BrowserWindow | null,
    private push: (msg: PushMessage) => void,
    private getSettings: () => SettingsView,
  ) {}

  start(): void {
    void this.scanInbox()
    this.scanTimer = setInterval(() => void this.scanInbox(), INBOX_POLL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.scanTimer) clearInterval(this.scanTimer)
    for (const s of this.sends.values()) if (s.timer) clearInterval(s.timer)
    this.sends.clear()
  }

  /** A peer's beacon hinted at a new drop for us (wired as chat.dropHintHandler). */
  noteHint(): void {
    void this.scanInbox()
  }

  private get session(): Session {
    return this.chat.session
  }

  private get io(): ShareIo {
    return this.session.io
  }

  private blobRel(recipient: string, dropId: string): string {
    return `${DIR.drops}/${recipient}/${dropId}${FILE_EXT.blob}`
  }

  private offerRel(recipient: string, dropId: string): string {
    return `${DIR.drops}/${recipient}/${dropId}.offer${FILE_EXT.record}`
  }

  private ackRel(recipient: string, dropId: string): string {
    return `${DIR.drops}/${recipient}/${dropId}.ack${FILE_EXT.record}`
  }

  private beamProgress(
    dropId: string,
    direction: 'send' | 'receive',
    peerDeviceId: string,
    name: string,
    size: number,
    state: BeamProgressView['state'],
    bytesDone: number,
    savedPath?: string,
  ): void {
    this.push({
      kind: 'beam-progress',
      progress: { dropId, direction, peerDeviceId, name, size, bytesDone, transport: 'folder', state, savedPath },
    })
  }

  // -------------------------------------------------------------------------
  // Sending

  async send(peerDeviceId: string, filePaths: string[]): Promise<{ dropId: string }> {
    if (!filePaths.length) throw new Error('no-files')
    const peer = this.session.roster.get(peerDeviceId)
    if (!peer) throw new Error('unknown-peer')
    const ids: string[] = []
    for (const p of filePaths) ids.push(await this.sendOne(peerDeviceId, peer.pin.xPub, p))
    return { dropId: ids[0] }
  }

  private async sendOne(peerId: string, peerXPub: string, filePath: string): Promise<string> {
    const st = await stat(filePath)
    const size = st.size
    const name = basename(filePath)
    const dropId = `${this.io.calibratedNow()}-${this.session.deviceId8}-${randomBytes(2).toString('hex')}`
    const blobKey = randomBytes(32)
    const blobRel = this.blobRel(peerId, dropId)
    const progress = (state: BeamProgressView['state'], bytesDone: number): void =>
      this.beamProgress(dropId, 'send', peerId, name, size, state, bytesDone)

    progress('connecting', 0)
    let sha256: string
    try {
      let lastPush = 0
      const res = await encryptFileToShare(
        this.io,
        filePath,
        size,
        blobKey,
        randomBytes(16),
        blobRel,
        buildAad('drop', blobRel, dropId),
        `${blobRel}.${randomBytes(4).toString('hex')}${FILE_EXT.partial}`,
        (done) => {
          const now = Date.now()
          if (now - lastPush >= 300) {
            lastPush = now
            progress('connecting', done)
          }
        },
      )
      sha256 = res.sha256
    } catch (err) {
      await this.io.delete(blobRel).catch(() => {})
      progress('failed', 0)
      throw err
    }

    const offer: DropOffer = {
      type: 'drop-offer',
      dropId,
      from: this.session.deviceId,
      name,
      size,
      mime: mimeForName(name),
      sha256,
      blobKey: blobKey.toString('base64'),
    }
    const oRel = this.offerRel(peerId, dropId)
    const sealed = sealRecord(
      importX25519Pub(peerXPub),
      KID.seal(peerId),
      Buffer.from(JSON.stringify(offer)),
      buildAad('drop', oRel, dropId),
    )
    try {
      await this.io.publish(oRel, sealed)
    } catch (err) {
      await this.io.delete(blobRel).catch(() => {})
      progress('failed', 0)
      throw err
    }
    this.chat.beacon.noteDropHint(peerId)
    progress('waiting', 0)

    const send: ActiveSend = {
      dropId,
      peer: peerId,
      name,
      size,
      startedAt: Date.now(),
      timer: null,
      done: false,
      polling: false,
    }
    this.sends.set(dropId, send)
    send.timer = setInterval(() => void this.pollAck(send), ACK_POLL_MS)
    return dropId
  }

  private async pollAck(send: ActiveSend): Promise<void> {
    if (send.done || send.polling) return
    send.polling = true
    try {
      const aRel = this.ackRel(send.peer, send.dropId)
      try {
        const buf = await this.io.readMaybe(aRel)
        if (buf) {
          const plain = openSealedRecord(buf, this.session.identity.xPriv, buildAad('drop-ack', aRel, send.dropId))
          const ack = JSON.parse(plain.toString('utf8')) as DropAck
          if (ack.state === 'accepted') {
            this.beamProgress(send.dropId, 'send', send.peer, send.name, send.size, 'transferring', 0)
          } else if (ack.state === 'receiving') {
            this.beamProgress(send.dropId, 'send', send.peer, send.name, send.size, 'transferring', ack.bytesDone ?? 0)
          } else if (ack.state === 'saved') {
            await this.finishSend(send, 'saved')
          } else if (ack.state === 'declined') {
            await this.finishSend(send, 'declined')
          }
          return
        }
      } catch {
        // unreadable/corrupt ack — keep polling until the deadline
      }
      if (Date.now() - send.startedAt > DROP.failedAfterMs) await this.finishSend(send, 'failed')
    } finally {
      send.polling = false
    }
  }

  private async finishSend(send: ActiveSend, state: 'saved' | 'declined' | 'failed' | 'canceled'): Promise<void> {
    if (send.done) return
    send.done = true
    if (send.timer) clearInterval(send.timer)
    this.sends.delete(send.dropId)
    // Recipient removed blob+offer on saved/declined; we clean up the ack —
    // and, when nothing was delivered, our own blob+offer too.
    await this.io.delete(this.ackRel(send.peer, send.dropId)).catch(() => {})
    if (state === 'failed' || state === 'canceled') {
      await this.io.delete(this.blobRel(send.peer, send.dropId)).catch(() => {})
      await this.io.delete(this.offerRel(send.peer, send.dropId)).catch(() => {})
    }
    this.beamProgress(send.dropId, 'send', send.peer, send.name, send.size, state, state === 'saved' ? send.size : 0)
    if (state === 'saved') {
      // Permanent beam-receipt row in the DM history.
      const conv = this.session.convIdForPeer(send.peer)
      if (conv) {
        try {
          const payload: SysPayload = {
            t: 'sys',
            conv,
            kind: 'beam-receipt',
            data: { name: send.name, size: send.size, outcome: 'saved' },
          }
          const ev = await this.chat.events.publish(conv, 'sys', payload)
          this.chat.beacon.noteOwnEvent(conv, `${ev.id}.sys.e1`)
        } catch {
          // receipt is best-effort
        }
      }
    }
  }

  async cancel(dropId: string): Promise<void> {
    const send = this.sends.get(dropId)
    if (send) {
      await this.finishSend(send, 'canceled')
      return
    }
    const inc = this.incoming.get(dropId)
    if (inc && !inc.busy) await this.rejectIncoming(dropId, inc, 'canceled')
  }

  // -------------------------------------------------------------------------
  // Receiving

  private async scanInbox(): Promise<void> {
    if (this.stopped) return
    if (this.scanning) {
      this.scanQueued = true
      return
    }
    this.scanning = true
    try {
      const suffix = `.offer${FILE_EXT.record}`
      const names = await this.io.list(`${DIR.drops}/${this.session.deviceId}`)
      for (const n of names) {
        if (!n.endsWith(suffix)) continue
        const dropId = n.slice(0, -suffix.length)
        if (this.incoming.has(dropId) || this.handled.has(dropId)) continue
        await this.ingestOffer(dropId).catch(() => {})
      }
    } catch {
      // share hiccup — the next hint/poll retries
    } finally {
      this.scanning = false
      if (this.scanQueued) {
        this.scanQueued = false
        void this.scanInbox()
      }
    }
  }

  private async ingestOffer(dropId: string): Promise<void> {
    const oRel = this.offerRel(this.session.deviceId, dropId)
    const buf = await this.io.readMaybe(oRel)
    if (!buf) return
    let offer: DropOffer
    try {
      const plain = openSealedRecord(buf, this.session.identity.xPriv, buildAad('drop', oRel, dropId))
      offer = JSON.parse(plain.toString('utf8')) as DropOffer
    } catch {
      this.handled.add(dropId) // corrupt / not actually for us — never retry-loop
      return
    }
    if (offer.type !== 'drop-offer' || offer.dropId !== dropId) {
      this.handled.add(dropId)
      return
    }
    this.incoming.set(dropId, { offer, busy: false })
    this.push({
      kind: 'beam-offer',
      offer: {
        dropId,
        fromDeviceId: offer.from,
        name: offer.name,
        size: offer.size,
        mime: offer.mime,
        note: offer.note,
        thumb: offer.thumb,
      },
    })

    const pin = this.session.roster.get(offer.from)?.pin
    const win = this.getWindow()
    if (!win?.isFocused() && Notification.isSupported()) {
      const n = new Notification({
        title: `${pin?.displayName ?? 'Someone'} wants to beam you a file`,
        body: `${offer.name} · ${fmtBytes(offer.size)}`,
      })
      n.on('click', () => {
        win?.show()
        win?.focus()
      })
      n.show()
    }

    // Auto-accept only for devices we know and haven't flagged — an unknown or
    // suspicious sender always goes through the explicit accept card.
    if (this.getSettings().autoAcceptBeams && pin && pin.trust !== 'flagged' && pin.trust !== 'revoked') {
      void this.accept(dropId).catch(() => {})
    }
  }

  async accept(dropId: string, savePath?: string): Promise<void> {
    const inc = this.incoming.get(dropId)
    if (!inc) throw new Error('unknown-drop')
    if (inc.busy) return
    inc.busy = true
    const offer = inc.offer
    const selfId = this.session.deviceId
    const blobRel = this.blobRel(selfId, dropId)
    const recv = (state: BeamProgressView['state'], bytesDone: number, saved?: string): void =>
      this.beamProgress(dropId, 'receive', offer.from, offer.name, offer.size, state, bytesDone, saved)

    // Serialized ack writes — single-writer (us), overwrite-in-place is safe.
    let ackChain: Promise<void> = Promise.resolve()
    const queueAck = (ack: DropAck): void => {
      ackChain = ackChain.then(() => this.writeAck(offer, ack)).catch(() => {})
    }

    let part: string | null = null
    try {
      let dest = savePath
      if (!dest) {
        const dir = join(app.getPath('downloads'), APP.downloadsSubdir)
        await mkdir(dir, { recursive: true })
        dest = await uniquePath(join(dir, sanitizeFileName(offer.name)))
      }
      await this.writeAck(offer, { type: 'drop-ack', dropId, state: 'accepted' })
      recv('transferring', 0)

      part = `${dest}.${randomBytes(4).toString('hex')}${FILE_EXT.partial}`
      let lastPush = 0
      let lastAck = 0
      const { sha256 } = await decryptSfb1File(
        this.io.abs(blobRel),
        Buffer.from(offer.blobKey, 'base64'),
        buildAad('drop', blobRel, dropId),
        part,
        (done) => {
          const now = Date.now()
          if (now - lastPush >= 250) {
            lastPush = now
            recv('transferring', done)
          }
          if (now - lastAck >= ACK_POLL_MS) {
            lastAck = now
            queueAck({ type: 'drop-ack', dropId, state: 'receiving', bytesDone: done })
          }
        },
      )
      if (sha256 !== offer.sha256) throw new Error('sha256-mismatch')
      await rename(part, dest)
      part = null
      await ackChain
      await this.writeAck(offer, { type: 'drop-ack', dropId, state: 'saved', bytesDone: offer.size })
      await this.io.delete(this.offerRel(selfId, dropId)).catch(() => {})
      await this.io.delete(blobRel).catch(() => {})
      this.incoming.delete(dropId)
      this.handled.add(dropId)
      recv('saved', offer.size, dest)
      shell.showItemInFolder(dest)
    } catch (err) {
      if (part) await rm(part, { force: true }).catch(() => {})
      inc.busy = false
      const gone = (err as NodeJS.ErrnoException).code === 'ENOENT'
      if (gone) {
        // Janitor (or the sender) removed the blob — the offer is dead.
        this.incoming.delete(dropId)
        this.handled.add(dropId)
        recv('expired', 0)
      } else {
        // No 'failed' ack state exists — the sender times out on its own.
        recv('failed', 0)
      }
      throw err
    }
  }

  async decline(dropId: string): Promise<void> {
    const inc = this.incoming.get(dropId)
    if (!inc || inc.busy) return
    await this.rejectIncoming(dropId, inc, 'declined')
  }

  private async rejectIncoming(dropId: string, inc: IncomingOffer, state: 'declined' | 'canceled'): Promise<void> {
    this.incoming.delete(dropId)
    this.handled.add(dropId)
    await this.writeAck(inc.offer, { type: 'drop-ack', dropId, state: 'declined' }).catch(() => {})
    await this.io.delete(this.blobRel(this.session.deviceId, dropId)).catch(() => {})
    await this.io.delete(this.offerRel(this.session.deviceId, dropId)).catch(() => {})
    this.beamProgress(dropId, 'receive', inc.offer.from, inc.offer.name, inc.offer.size, state, 0)
  }

  /** Seal a DropAck to the sender and publish it into our own inbox dir. */
  private async writeAck(offer: DropOffer, ack: DropAck): Promise<void> {
    const sender = this.session.roster.get(offer.from) ?? (await this.session.roster.loadOne(offer.from))
    if (!sender) throw new Error('unknown-sender')
    const aRel = this.ackRel(this.session.deviceId, offer.dropId)
    const sealed = sealRecord(
      importX25519Pub(sender.pin.xPub),
      KID.seal(offer.from),
      Buffer.from(JSON.stringify(ack)),
      buildAad('drop-ack', aRel, offer.dropId),
    )
    await this.io.publish(aRel, sealed)
  }
}
