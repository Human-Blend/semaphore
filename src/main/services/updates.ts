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

/** How long a peer-announced version keeps re-checking for the signed manifest. */
const PEER_RECHECK_MS = 60_000
const PEER_RECHECK_FOR_MS = 10 * 60_000

export class UpdateService {
  private timer: NodeJS.Timeout | null = null
  private recheck: NodeJS.Timeout | null = null
  /** The one-shot check just after launch; tracked so stop() can cancel it. */
  private firstCheck: NodeJS.Timeout | null = null
  private lastMtime = 0
  private manifest: VersionManifest | null = null
  /** Peer-announced versions already surfaced once — one banner per version. */
  private announcedPeerVersions = new Set<string>()

  constructor(
    private session: Session,
    private push: (msg: PushMessage) => void,
    /** This build's version. Injected so the budget/peer tests need no app. */
    private getVersion: () => string = () => app.getVersion(),
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.check(), POLL.updateMs)
    this.firstCheck = setTimeout(() => {
      this.firstCheck = null
      void this.check()
    }, 20_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.recheck) clearInterval(this.recheck)
    this.recheck = null
    if (this.firstCheck) clearTimeout(this.firstCheck)
    this.firstCheck = null
  }

  /**
   * A teammate's beacon says they are on `version` (1.2's `app` field). If that
   * is newer than this build, force one manifest re-check: usually the release
   * zip and its signed `apps/version.json` are already there and the normal
   * banner is the right answer. When they aren't — someone updated by hand, or
   * the manifest write raced us — say so plainly and point at the folder,
   * re-checking for ten minutes in case the zip is still being copied.
   */
  notePeerVersion(version: string, peerName: string): void {
    if (!semver.valid(version)) return
    const mine = this.getVersion()
    if (!semver.valid(mine) || !semver.gt(version, mine)) return
    if (this.announcedPeerVersions.has(version)) return
    this.announcedPeerVersions.add(version)
    void this.onPeerVersion(version, peerName)
  }

  private async onPeerVersion(version: string, peerName: string): Promise<void> {
    if (await this.check({ force: true, covering: version })) return
    this.push({
      kind: 'update',
      update: {
        version,
        notes: `${peerName} is already on Chat ${version}. The zip isn't in the apps folder yet.`,
        blocking: false,
        source: 'peer',
        peerName,
        zipAvailable: false,
      },
    })
    if (this.recheck) clearInterval(this.recheck)
    const until = Date.now() + PEER_RECHECK_FOR_MS
    // Each callback clears *its own* handle: a second peer announcing a newer
    // version while this one is still re-checking replaces `this.recheck`, and
    // the older interval's callback would otherwise clear (and null) the newer
    // timer — leaving itself running forever and the new one dead.
    const mine: NodeJS.Timeout = setInterval(() => {
      void (async () => {
        const landed = await this.check({ force: true, covering: version })
        if (landed || Date.now() >= until) {
          clearInterval(mine)
          if (this.recheck === mine) this.recheck = null
        }
      })()
    }, PEER_RECHECK_MS)
    this.recheck = mine
  }

  /**
   * Returns true when a verified manifest covering `opts.covering` (or, with no
   * `covering`, any newer version) is now known — the caller then leaves the
   * banner to the manifest path.
   */
  private async check(opts?: { force?: boolean; covering?: string }): Promise<boolean> {
    const s = this.session
    const current = this.getVersion()
    const covers = (m: VersionManifest | null): boolean =>
      !!m &&
      semver.valid(m.version) !== null &&
      semver.gt(m.version, current) &&
      (!opts?.covering || semver.gte(m.version, opts.covering))
    try {
      const rel = `${DIR.apps}/version.json`
      const st = await s.io.statMaybe(rel)
      if (!st) return false
      if (st.mtimeMs === this.lastMtime && !opts?.force) return covers(this.manifest)
      const unchanged = st.mtimeMs === this.lastMtime
      this.lastMtime = st.mtimeMs
      if (unchanged && this.manifest) return covers(this.manifest)
      const raw = await s.io.readMaybe(rel)
      if (!raw) return false
      const manifest = JSON.parse(raw.toString()) as VersionManifest
      if (!this.verify(manifest)) return false

      if (!semver.valid(manifest.version) || !semver.gt(manifest.version, current)) return false
      this.manifest = manifest
      const blocking = semver.valid(manifest.minSupported) ? semver.lt(current, manifest.minSupported) : false
      const update: UpdateView = {
        version: manifest.version,
        notes: manifest.notes,
        blocking,
        source: 'manifest',
        zipAvailable: true,
      }
      this.push({ kind: 'update', update })
      return covers(manifest)
    } catch {
      // update checks are always best-effort
      return false
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
