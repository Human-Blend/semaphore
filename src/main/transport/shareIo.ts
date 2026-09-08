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
import { dirname, join } from 'node:path'
import { FILE_EXT } from '@shared/constants'

// All share access goes through this class: temp-write-then-rename publishing,
// idempotent deletes, share-clock calibration, and mount health. Paths are
// share-relative POSIX strings; join() maps them to the mounted root.

export interface ShareHealth {
  reachable: boolean
  latencyMs: number | null
  lastError: string | null
}

export class ShareIo {
  readonly root: string
  /** EMA of (server mtime − local wall clock); null until first calibration. */
  private clockOffsetMs: number | null = null
  /** Set false by the conformance probe when mtimes echo writer clocks. */
  mtimeTrustworthy = true
  private health: ShareHealth = { reachable: true, latencyMs: null, lastError: null }

  constructor(root: string) {
    this.root = root
  }

  abs(rel: string): string {
    return join(this.root, ...rel.split('/'))
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
    try {
      await mkdir(dirname(absFinal), { recursive: true })
      await writeFile(tmp, data)
      await rename(tmp, absFinal)
      this.noteOk(Date.now() - t0)
      if (opts?.calibrate && this.mtimeTrustworthy) {
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
    try {
      const s = await stat(this.abs(rel))
      return { mtimeMs: s.mtimeMs, size: s.size }
    } catch {
      return null
    }
  }

  /** Idempotent delete — ENOENT is success; EBUSY/EPERM are skip-and-retry. */
  async delete(rel: string): Promise<'deleted' | 'retry'> {
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
