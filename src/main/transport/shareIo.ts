import { randomBytes } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { FILE_EXT } from '@shared/constants'

// All share access goes through this class: temp-write-then-rename publishing,
// idempotent deletes, share-clock calibration, and mount health. Paths are
// share-relative POSIX strings; join() maps them to the mounted root.

export interface ShareHealth {
  reachable: boolean
  latencyMs: number | null
  lastError: string | null
}

/** Logical share operations, in total and over the trailing 60 s (1.2). */
export interface ShareIoStats {
  sinceMs: number
  total: number
  byOp: Record<string, number>
  lastMinute: number
  ratePerSec: number
}

/** The primitives the counter distinguishes. A publish is ONE op, not three. */
export type ShareOp = 'readdir' | 'read' | 'stat' | 'publish' | 'delete' | 'mkdir'

const RING_SECONDS = 60

export class ShareIo {
  readonly root: string
  /** EMA of (server mtime − local wall clock); null until first calibration. */
  private clockOffsetMs: number | null = null
  /** Set false by the conformance probe when mtimes echo writer clocks. */
  mtimeTrustworthy = true
  private health: ShareHealth = { reachable: true, latencyMs: null, lastError: null }

  // --- I/O budget instrumentation (1.2). Every primitive below routes through
  // note(); the ring is 60 one-second buckets tagged with their own second, so
  // a quiet minute ages out without a sweep.
  private countedSince = Date.now()
  private opTotal = 0
  private byOp: Partial<Record<ShareOp, number>> = {}
  private ringSec = new Array<number>(RING_SECONDS).fill(-1)
  private ringCount = new Array<number>(RING_SECONDS).fill(0)

  constructor(root: string) {
    this.root = root
  }

  /** Count one logical share operation. Subclasses (test fakes) reuse it. */
  protected note(op: ShareOp): void {
    this.opTotal += 1
    this.byOp[op] = (this.byOp[op] ?? 0) + 1
    const sec = Math.floor(Date.now() / 1000)
    const i = ((sec % RING_SECONDS) + RING_SECONDS) % RING_SECONDS
    if (this.ringSec[i] !== sec) {
      this.ringSec[i] = sec
      this.ringCount[i] = 0
    }
    this.ringCount[i] += 1
  }

  /** Live traffic readout — Settings' "Share traffic" line and `diag:shareStats`. */
  stats(): ShareIoStats {
    const now = Date.now()
    const sec = Math.floor(now / 1000)
    let lastMinute = 0
    for (let i = 0; i < RING_SECONDS; i++) {
      const s = this.ringSec[i]
      if (s >= 0 && sec - s < RING_SECONDS) lastMinute += this.ringCount[i]
    }
    // Early on there is less than a minute of history; dividing by 60 anyway
    // would report a rate the client never ran at.
    const elapsedSec = Math.max(1, Math.min(RING_SECONDS, Math.round((now - this.countedSince) / 1000)))
    return {
      sinceMs: now - this.countedSince,
      total: this.opTotal,
      byOp: { ...this.byOp } as Record<string, number>,
      lastMinute,
      ratePerSec: Math.round((lastMinute / elapsedSec) * 100) / 100,
    }
  }

  /** Drop the history (tests measuring a steady state after startup). */
  resetStats(): void {
    this.countedSince = Date.now()
    this.opTotal = 0
    this.byOp = {}
    this.ringSec.fill(-1)
    this.ringCount.fill(0)
  }

  /**
   * Share-relative POSIX path → absolute path under the mounted root.
   *
   * Every segment is checked, because several relative paths are built from
   * ids that crossed the bridge: a live board's `sessionId` (1.3) and a screen
   * session's (1.2) both land in a path, and `join(root, '..', '..')` walks
   * straight out of the share. The services validate those ids too; this is
   * the floor under all of them, so a future caller cannot reintroduce the
   * hole by forgetting to.
   */
  abs(rel: string): string {
    // '' is the team root itself (ensureDir('') on first run, probe()); it
    // has no segments to check. Anything else must be a clean relative path.
    if (rel === '') return this.root
    if (isAbsolute(rel)) throw new Error(`unsafe share path: ${JSON.stringify(rel)}`)
    const parts = rel.split('/')
    for (const p of parts) {
      // Empty catches a leading, trailing or doubled slash; '\\' is a
      // separator on Windows, where it would smuggle a second segment past
      // this loop.
      if (!p || p === '.' || p === '..' || p.includes('\\')) {
        throw new Error(`unsafe share path: ${JSON.stringify(rel)}`)
      }
    }
    return join(this.root, ...parts)
  }

  getHealth(): ShareHealth {
    return { ...this.health }
  }

  /** Local wall clock corrected to the share server's clock. */
  calibratedNow(): number {
    return Date.now() + (this.clockOffsetMs ?? 0)
  }

  getClockOffsetMs(): number | null {
    return this.clockOffsetMs
  }

  private noteOk(latencyMs: number): void {
    this.health = { reachable: true, latencyMs, lastError: null }
  }

  private noteError(err: unknown): void {
    this.health = {
      reachable: false,
      latencyMs: this.health.latencyMs,
      lastError: err instanceof Error ? err.message : String(err),
    }
  }

  async ensureDir(rel: string): Promise<void> {
    this.note('mkdir')
    await mkdir(this.abs(rel), { recursive: true })
  }

  /**
   * Publish atomically: write `<name>.<rand>.partial` in the same directory,
   * then rename over the final name. Readers ignore *.partial. Optionally
   * calibrates the share clock from the resulting mtime.
   */
  async publish(rel: string, data: Buffer, opts?: { calibrate?: boolean }): Promise<void> {
    const absFinal = this.abs(rel)
    const tmp = `${absFinal}.${randomBytes(4).toString('hex')}${FILE_EXT.partial}`
    const t0 = Date.now()
    // mkdir + write + rename are one logical publish; only the optional
    // calibration stat is a second trip to the server.
    this.note('publish')
    try {
      await mkdir(dirname(absFinal), { recursive: true })
      await writeFile(tmp, data)
      await rename(tmp, absFinal)
      this.noteOk(Date.now() - t0)
      if (opts?.calibrate && this.mtimeTrustworthy) {
        this.note('stat')
        try {
          const s = await stat(absFinal)
          const observed = s.mtimeMs - Date.now()
          this.clockOffsetMs =
            this.clockOffsetMs === null ? observed : this.clockOffsetMs * 0.7 + observed * 0.3
        } catch {
          // calibration is best-effort
        }
      }
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      this.noteError(err)
      throw err
    }
  }

  /** Exclusive create for bootstrap races. Returns false on EEXIST. */
  async createExclusive(rel: string, data: Buffer): Promise<boolean> {
    this.note('publish')
    await mkdir(dirname(this.abs(rel)), { recursive: true })
    try {
      const fd = await open(this.abs(rel), 'wx')
      try {
        await fd.writeFile(data)
      } finally {
        await fd.close()
      }
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
      this.noteError(err)
      throw err
    }
  }

  async read(rel: string): Promise<Buffer> {
    const t0 = Date.now()
    this.note('read')
    try {
      const buf = await readFile(this.abs(rel))
      this.noteOk(Date.now() - t0)
      return buf
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.noteError(err)
      throw err
    }
  }

  async readMaybe(rel: string): Promise<Buffer | null> {
    try {
      return await this.read(rel)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  /** Directory listing, filtering out partials/hidden. Empty array on ENOENT. */
  async list(rel: string): Promise<string[]> {
    const t0 = Date.now()
    this.note('readdir')
    try {
      const names = await readdir(this.abs(rel))
      this.noteOk(Date.now() - t0)
      return names.filter((n) => !n.endsWith(FILE_EXT.partial) && !n.startsWith('.'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      this.noteError(err)
      throw err
    }
  }

  async listDirs(rel: string): Promise<string[]> {
    this.note('readdir')
    try {
      const entries = await readdir(this.abs(rel), { withFileTypes: true })
      return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      this.noteError(err)
      throw err
    }
  }

  async statMaybe(rel: string): Promise<{ mtimeMs: number; size: number } | null> {
    return (await this.statDetailed(rel)).stat
  }

  /**
   * `statMaybe` with the reason kept.
   *
   * A caller that has to tell "this file is gone" from "this share is not
   * there right now" needs the errno that `statMaybe`'s null throws away — the
   * sfblob:// handler answering 404-expired vs 503-try-again is the one that
   * does (see `blobMissStatus`). Everything else wants the plain null.
   */
  async statDetailed(rel: string): Promise<{ stat: { mtimeMs: number; size: number } | null; code?: string }> {
    this.note('stat')
    try {
      const s = await stat(this.abs(rel))
      return { stat: { mtimeMs: s.mtimeMs, size: s.size } }
    } catch (err) {
      return { stat: null, code: (err as NodeJS.ErrnoException).code }
    }
  }

  /** Idempotent delete — ENOENT is success; EBUSY/EPERM are skip-and-retry. */
  async delete(rel: string): Promise<'deleted' | 'retry'> {
    this.note('delete')
    try {
      await rm(this.abs(rel), { force: true, recursive: true })
      return 'deleted'
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return 'retry'
      throw err
    }
  }

  /** Cheap reachability probe (stat the root). */
  async probe(): Promise<boolean> {
    this.note('stat')
    try {
      await stat(this.root)
      this.health.reachable = true
      return true
    } catch (err) {
      this.noteError(err)
      return false
    }
  }

  /** Write + read-back + latency health check used by onboarding. */
  async healthCheck(): Promise<{ writable: boolean; readBack: boolean; latencyMs: number }> {
    const rel = `.health-${randomBytes(4).toString('hex')}`
    const payload = randomBytes(64)
    const t0 = Date.now()
    try {
      await this.publish(rel, payload)
      const back = await this.read(rel)
      const latencyMs = Date.now() - t0
      await this.delete(rel)
      return { writable: true, readBack: back.equals(payload), latencyMs }
    } catch {
      return { writable: false, readBack: false, latencyMs: Date.now() - t0 }
    }
  }
}
