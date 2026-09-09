import { app } from 'electron'
import { createHash, verify as edVerify, createPublicKey } from 'node:crypto'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import semver from 'semver'
import { canonicalJson } from '@shared/canonicalJson'
import { DIR, DST, POLL } from '@shared/constants'
import type { VersionManifest } from '@shared/types'
import type { PushMessage, UpdateView } from '@shared/bridge'
import type { Session } from '../transport/session'

// Update banner: apps/version.json on the share, signed by the RELEASE key
// baked into this binary (share ACLs are never the trust root — anyone can
// write to the share). Nothing self-replaces; the human copies the new zip.

// The release public key (raw Ed25519, base64url). scripts/release.mjs prints
// the matching value on first run; paste it here before the first team release.
// Empty string disables signature enforcement (dev builds only, warns).
//
// Baked in for 1.1.0. The private half lives ONLY at ~/.semaphore-release-key.json
// on the build Mac (never in this repo) — back it up: without it, no future
// release can be signed for these clients and the team needs a hand-delivered
// build carrying a new key.
export const RELEASE_PUBKEY_B64URL = '3FqH-RQxnKLVt-1FL1G1dDWt-GYO9T56bAtdeQvG4VY'

export class UpdateService {
  private timer: NodeJS.Timeout | null = null
  private lastMtime = 0
  private manifest: VersionManifest | null = null

  constructor(
    private session: Session,
    private push: (msg: PushMessage) => void,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.check(), POLL.updateMs)
    setTimeout(() => void this.check(), 20_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private async check(): Promise<void> {
    const s = this.session
    try {
      const rel = `${DIR.apps}/version.json`
      const st = await s.io.statMaybe(rel)
      if (!st || st.mtimeMs === this.lastMtime) return
      this.lastMtime = st.mtimeMs
      const raw = await s.io.readMaybe(rel)
      if (!raw) return
      const manifest = JSON.parse(raw.toString()) as VersionManifest
      if (!this.verify(manifest)) return

      const current = app.getVersion()
      if (!semver.valid(manifest.version) || !semver.gt(manifest.version, current)) return
      this.manifest = manifest
      const blocking = semver.valid(manifest.minSupported) ? semver.lt(current, manifest.minSupported) : false
      const update: UpdateView = { version: manifest.version, notes: manifest.notes, blocking }
      this.push({ kind: 'update', update })
    } catch {
      // update checks are always best-effort
    }
  }

  private verify(manifest: VersionManifest): boolean {
    if (!RELEASE_PUBKEY_B64URL) return true // dev mode — no key baked yet
    try {
      const { sig, ...rest } = manifest
      const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: RELEASE_PUBKEY_B64URL }, format: 'jwk' })
      const input = Buffer.concat([
        Buffer.from(DST.release, 'ascii'),
        Buffer.from([0]),
        Buffer.from(canonicalJson(rest), 'utf8'),
      ])
      return edVerify(null, input, pub, Buffer.from(sig, 'base64'))
    } catch {
      return false
    }
  }

  /** Copy the right zip locally, verify sha256, reveal it. */
  async copyToMachine(): Promise<{ path: string } | { error: string }> {
    const m = this.manifest
    if (!m) return { error: 'no update available' }
    const key = process.platform === 'darwin' ? 'mac-arm64' : 'win-x64'
    const file = m.files[key]
    if (!file) return { error: `no build for ${key} in this release` }
    try {
      const src = this.session.io.abs(`${DIR.apps}/${file.name}`)
      const destDir = process.platform === 'darwin' ? join(homedir(), 'Desktop') : join(homedir(), 'Downloads')
      await mkdir(destDir, { recursive: true })
      const dest = join(destDir, file.name)
      await copyFile(src, dest)
      const hash = createHash('sha256').update(await readFile(dest)).digest('hex')
      if (hash !== file.sha256) return { error: 'copy failed hash verification — try again (SMB copies can corrupt)' }
      return { path: dest }
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'copy failed' }
    }
  }
}
