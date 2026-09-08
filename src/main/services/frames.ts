import { DIR, FRAME, POLL } from '@shared/constants'
import type { PushMessage } from '@shared/bridge'
import type { Session } from '../transport/session'

// Frame-relay store: the presenter writes encrypted WebP stills into a
// ring-buffer directory; viewers poll and render the newest. Sequence numbers
// (never timestamps) define order. Viewer heartbeats drive the presenter's
// audience count and stop-when-empty. Frame bytes are opaque here — the
// renderer encrypts/decrypts with the session frame key it holds.

const FRAME_RE = /^f-(\d{6})\.bin$/
const HB_RE = /^v-([0-9a-f]{8})\.hb$/

export class FrameStore {
  // Presenter side
  private publishedSeqs = new Map<string, number[]>() // sessionId -> recent seqs
  private viewerWatch = new Map<string, NodeJS.Timeout>()
  // Viewer side
  private subs = new Map<string, { timer: NodeJS.Timeout; lastSeq: number; hbTimer: NodeJS.Timeout }>()

  constructor(
    private session: Session,
    private push: (msg: PushMessage) => void,
  ) {}

  stop(): void {
    for (const t of this.viewerWatch.values()) clearInterval(t)
    for (const s of this.subs.values()) {
      clearInterval(s.timer)
      clearInterval(s.hbTimer)
    }
    this.viewerWatch.clear()
    this.subs.clear()
  }

  // -------------------------------------------------------------------------
  // Presenter

  async publish(sessionId: string, seq: number, bytes: Uint8Array): Promise<void> {
    const s = this.session
    const dir = `${DIR.screens}/${sessionId}`
    const name = `f-${String(seq).padStart(6, '0')}.bin`
    await s.io.publish(`${dir}/${name}`, Buffer.from(bytes))
    const seqs = this.publishedSeqs.get(sessionId) ?? []
    seqs.push(seq)
    while (seqs.length > FRAME.ringDepth) {
      const old = seqs.shift()!
      await s.io.delete(`${dir}/f-${String(old).padStart(6, '0')}.bin`).catch(() => {})
    }
    this.publishedSeqs.set(sessionId, seqs)
  }

  watchViewers(sessionId: string, on: boolean): void {
    const existing = this.viewerWatch.get(sessionId)
    if (!on) {
      if (existing) clearInterval(existing)
      this.viewerWatch.delete(sessionId)
      return
    }
    if (existing) return
    const timer = setInterval(async () => {
      try {
        const names = await this.session.io.list(`${DIR.screens}/${sessionId}`)
        let count = 0
        const now = Date.now()
        for (const n of names) {
          if (!HB_RE.test(n)) continue
          const st = await this.session.io.statMaybe(`${DIR.screens}/${sessionId}/${n}`)
          // Heartbeat freshness vs OUR clock via share mtime + offset drift is
          // fine at 30s granularity.
          if (st && now + (this.session.io.getClockOffsetMs() ?? 0) - st.mtimeMs < FRAME.viewerStaleMs) count++
        }
        this.push({ kind: 'frame-viewers', sessionId, count })
      } catch {
        // ignore
      }
    }, FRAME.viewerHeartbeatMs)
    this.viewerWatch.set(sessionId, timer)
  }

  /** Presenter cleanup on stop: remove the whole session dir. */
  async endSession(sessionId: string): Promise<void> {
    this.watchViewers(sessionId, false)
    this.publishedSeqs.delete(sessionId)
    await this.session.io.delete(`${DIR.screens}/${sessionId}`).catch(() => {})
  }

  // -------------------------------------------------------------------------
  // Viewer

  subscribe(sessionId: string): void {
    if (this.subs.has(sessionId)) return
    const s = this.session
    const dir = `${DIR.screens}/${sessionId}`
    const state = { lastSeq: -1 }

    const timer = setInterval(async () => {
      try {
        const names = await s.io.list(dir)
        let maxSeq = -1
        let maxName = ''
        for (const n of names) {
          const m = FRAME_RE.exec(n)
          if (m) {
            const seq = Number(m[1])
            if (seq > maxSeq) {
              maxSeq = seq
              maxName = n
            }
          }
        }
        if (maxSeq > state.lastSeq && maxName) {
          const buf = await s.io.readMaybe(`${dir}/${maxName}`)
          if (buf) {
            state.lastSeq = maxSeq
            this.push({ kind: 'frame', sessionId, seq: maxSeq, bytes: new Uint8Array(buf) })
          }
        }
      } catch {
        // ignore
      }
    }, POLL.frameMs)

    const hbName = `${dir}/v-${s.deviceId8}.hb`
    const hbTimer = setInterval(() => {
      void s.io.publish(hbName, Buffer.from(String(state.lastSeq))).catch(() => {})
    }, FRAME.viewerHeartbeatMs)
    void s.io.publish(hbName, Buffer.from('0')).catch(() => {})

    this.subs.set(sessionId, { timer, hbTimer, lastSeq: -1 })
  }

  unsubscribe(sessionId: string): void {
    const sub = this.subs.get(sessionId)
    if (!sub) return
    clearInterval(sub.timer)
    clearInterval(sub.hbTimer)
    this.subs.delete(sessionId)
    void this.session.io.delete(`${DIR.screens}/${sessionId}/v-${this.session.deviceId8}.hb`).catch(() => {})
  }
}
