#!/usr/bin/env node
// One-command release from the build Mac:
//   npm run release                      → build both platforms into dist/
//   SHARE_PATH=/Volumes/TeamShare npm run release   → also publish to the share
//
// Steps: natives gate → typecheck+tests → electron-vite build → electron-builder
// (mac zip + win zip, cross-built, no wine) → sha256 → signed version.json →
// publish zips first, manifest last (rename-atomic), rotate one archive.

import { execSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash, generateKeyPairSync, createPrivateKey, sign } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const run = (cmd) => execSync(cmd, { stdio: 'inherit', cwd: root })

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
console.log(`\n— Semaphore release v${version} —\n`)

// 1-2. Gates
run('node scripts/check-no-natives.mjs')
run('npm run typecheck')
run('npm test')

// 3-4. Build + package
run('npm run build')
run('npx electron-builder --mac --win')

// 5. Collect artifacts
const dist = join(root, 'dist')
const zips = readdirSync(dist).filter((f) => f.endsWith('.zip') && f.includes(version))
if (zips.length === 0) {
  console.error('no zips found in dist/')
  process.exit(1)
}
const files = {}
for (const z of zips) {
  const buf = readFileSync(join(dist, z))
  const sha256 = createHash('sha256').update(buf).digest('hex')
  const key = z.includes('mac') ? 'mac-arm64' : z.includes('win') ? 'win-x64' : z
  files[key] = { name: z, sha256, bytes: buf.length }
  console.log(`  ${z}  ${(buf.length / 1e6).toFixed(1)} MB  ${sha256.slice(0, 16)}…`)
}

// 6. Release key (generated once, lives OUTSIDE the repo)
const keyPath = join(homedir(), '.semaphore-release-key.json')
let priv
if (!existsSync(keyPath)) {
  const kp = generateKeyPairSync('ed25519')
  const privDer = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  const pubRaw = kp.publicKey.export({ format: 'jwk' }).x
  writeFileSync(keyPath, JSON.stringify({ privDer, pubRaw }, null, 2), { mode: 0o600 })
  console.log(`\nNEW release key generated at ${keyPath}`)
  console.log(`Paste this public key into src/main/services/updates.ts RELEASE_PUBKEY_B64URL and rebuild:\n\n  ${pubRaw}\n`)
}
const keyData = JSON.parse(readFileSync(keyPath, 'utf8'))
priv = createPrivateKey({ key: Buffer.from(keyData.privDer, 'base64'), format: 'der', type: 'pkcs8' })

// Canonical JSON (matches src/shared/canonicalJson.ts)
const canonical = (v) => {
  if (v === null || typeof v === 'boolean' || typeof v === 'number') return JSON.stringify(v)
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map((x) => canonical(x ?? null)).join(',') + ']'
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
}

const manifestBody = {
  schema: 1,
  version,
  released: new Date().toISOString(),
  minSupported: pkg.minSupported ?? '1.0.0',
  notes: process.env.NOTES ?? '',
  files,
}
const sigInput = Buffer.concat([
  Buffer.from('smbchat-v1-release', 'ascii'),
  Buffer.from([0]),
  Buffer.from(canonical(manifestBody), 'utf8'),
])
const manifest = { ...manifestBody, sig: sign(null, sigInput, priv).toString('base64') }
writeFileSync(join(dist, 'version.json'), JSON.stringify(manifest, null, 2))
console.log('\nversion.json written (signed).')

// 7. Publish to the share
const sharePath = process.env.SHARE_PATH
if (!sharePath) {
  console.log('\nSHARE_PATH not set — artifacts left in dist/. To publish:')
  console.log('  SHARE_PATH=/Volumes/TeamShare npm run release')
  process.exit(0)
}
const appsDir = join(sharePath, 'Semaphore', 'apps')
const archiveDir = join(appsDir, 'archive')
mkdirSync(archiveDir, { recursive: true })

// Rotate: current zips → archive; prune archive to the single newest version
for (const f of readdirSync(appsDir)) {
  if (f.endsWith('.zip')) renameSync(join(appsDir, f), join(archiveDir, f))
}
const archived = readdirSync(archiveDir).filter((f) => f.endsWith('.zip'))
const archivedVersions = [...new Set(archived.map((f) => f.match(/(\d+\.\d+\.\d+)/)?.[1]).filter(Boolean))].sort()
for (const v of archivedVersions.slice(0, -1)) {
  for (const f of archived.filter((name) => name.includes(v))) {
    rmSync(join(archiveDir, f), { force: true })
  }
}

// Copy zips, verify after copy (SMB copies can corrupt)
for (const [, meta] of Object.entries(files)) {
  const src = join(dist, meta.name)
  const dst = join(appsDir, meta.name)
  copyFileSync(src, dst)
  const back = createHash('sha256').update(readFileSync(dst)).digest('hex')
  if (back !== meta.sha256) {
    console.error(`HASH MISMATCH after copy: ${meta.name} — aborting before manifest publish`)
    process.exit(1)
  }
  console.log(`  published ${meta.name} ✓`)
}

// Manifest LAST via temp+rename so clients never see it before its zips
const tmp = join(appsDir, 'version.json.partial')
writeFileSync(tmp, JSON.stringify(manifest, null, 2))
renameSync(tmp, join(appsDir, 'version.json'))

// README for teammates
writeFileSync(
  join(appsDir, 'README-INSTALL.txt'),
  `Semaphore ${version} — install
==============================

macOS
1. Copy Semaphore-${version}-mac-arm64.zip from this folder to your Desktop.
   (Copy the ZIP itself — don't unzip it here.)
2. Double-click the zip, drag Semaphore.app into /Applications.
3. Double-click Semaphore. It should just open.
   If macOS says it "could not verify" the app (only happens when the zip
   came via a browser/AirDrop instead of this folder):
   System Settings → Privacy & Security → "Open Anyway", or in Terminal:
   xattr -dr com.apple.quarantine /Applications/Semaphore.app

Windows
1. Copy Semaphore-${version}-win-x64.zip to your machine.
2. Right-click → Extract All into %LOCALAPPDATA%\\Semaphore (or your Desktop).
3. Double-click Semaphore.exe.
   If SmartScreen appears: "More info" → "Run anyway"
   (or file Properties → Unblock before extracting).

First run: pick this team folder's parent, enter the team passphrase, choose
your name. Screen sharing on macOS will ask for Screen Recording permission
and may ask again after updates — that's expected for an internally-built app.
`,
)
console.log('\nRelease published to the share. Teammates get the update banner within ~5 minutes.')
