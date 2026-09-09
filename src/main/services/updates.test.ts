import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, verify as edVerify, createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson } from '@shared/canonicalJson'
import { DST } from '@shared/constants'
import type { VersionManifest } from '@shared/types'

// updates.ts pulls in electron for app.getVersion(); the signature check itself
// is pure node:crypto, so a stub is enough to import the constant + class.
vi.mock('electron', () => ({ app: { getVersion: () => '1.1.0' } }))

const { RELEASE_PUBKEY_B64URL, UpdateService } = await import('./updates')

// The signing half lives in scripts/release.mjs (a standalone build script, not
// importable from src). It hand-rolls canonical JSON and the domain tag, so the
// two implementations can drift apart silently — and the symptom would be every
// client quietly ignoring a real release. This pins them together.
const signLikeRelease = (body: object, privDerB64: string): string => {
  const script = `
    const { createPrivateKey, sign } = require('node:crypto')
    const canonical = (v) => {
      if (v === null || typeof v === 'boolean' || typeof v === 'number') return JSON.stringify(v)
      if (typeof v === 'string') return JSON.stringify(v)
      if (Array.isArray(v)) return '[' + v.map((x) => canonical(x ?? null)).join(',') + ']'
      const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
    }
    const body = JSON.parse(process.argv[1])
    const priv = createPrivateKey({ key: Buffer.from(process.argv[2], 'base64'), format: 'der', type: 'pkcs8' })
    const input = Buffer.concat([
      Buffer.from('smbchat-v1-release', 'ascii'),
      Buffer.from([0]),
      Buffer.from(canonical(body), 'utf8'),
    ])
    process.stdout.write(sign(null, input, priv).toString('base64'))
  `
  return execFileSync(process.execPath, ['-e', script, JSON.stringify(body), privDerB64], {
    encoding: 'utf8',
  })
}

const manifestBody = (over: Partial<VersionManifest> = {}) => ({
  schema: 1,
  version: '1.2.0',
  released: '2026-09-09T06:00:00.000Z',
  minSupported: '1.0.0',
  notes: 'Splash, calendar, pull requests',
  files: {
    'mac-arm64': { name: 'Chat-1.2.0-mac-arm64.zip', sha256: 'a'.repeat(64), bytes: 143_500_000 },
    'win-x64': { name: 'Chat-1.2.0-win-x64.zip', sha256: 'b'.repeat(64), bytes: 171_700_000 },
  },
  ...over,
})

// `verify` is private; the boundary under test is the signature, not the class.
const verifyWith = (svc: InstanceType<typeof UpdateService>, manifest: VersionManifest): boolean =>
  (svc as unknown as { verify(m: VersionManifest): boolean }).verify(manifest)

describe('release manifest signatures', () => {
  it('accepts a manifest signed the way scripts/release.mjs signs it', () => {
    const kp = generateKeyPairSync('ed25519')
    const privDer = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    const pubRaw = kp.publicKey.export({ format: 'jwk' }).x as string

    const body = manifestBody()
    const sig = signLikeRelease(body, privDer)

    // The renderer-side check, with the test key standing in for the baked one.
    const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pubRaw }, format: 'jwk' })
    const input = Buffer.concat([
      Buffer.from(DST.release, 'ascii'),
      Buffer.from([0]),
      Buffer.from(canonicalJson(body), 'utf8'),
    ])
    expect(edVerify(null, input, pub, Buffer.from(sig, 'base64'))).toBe(true)
  })

  it('rejects a manifest whose body was edited after signing', () => {
    const kp = generateKeyPairSync('ed25519')
    const privDer = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    const pubRaw = kp.publicKey.export({ format: 'jwk' }).x as string

    const body = manifestBody()
    const sig = signLikeRelease(body, privDer)
    const tampered = { ...body, files: { ...body.files, 'mac-arm64': { ...body.files['mac-arm64'], sha256: 'c'.repeat(64) } } }

    const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pubRaw }, format: 'jwk' })
    const input = Buffer.concat([
      Buffer.from(DST.release, 'ascii'),
      Buffer.from([0]),
      Buffer.from(canonicalJson(tampered), 'utf8'),
    ])
    expect(edVerify(null, input, pub, Buffer.from(sig, 'base64'))).toBe(false)
  })

  it('has a release key baked in, so the share is not the trust root', () => {
    // 1.0.x shipped with this empty (verify() short-circuits to true, i.e.
    // anyone who can write to the share can raise an update banner).
    expect(RELEASE_PUBKEY_B64URL).not.toBe('')
    expect(RELEASE_PUBKEY_B64URL).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('rejects a manifest signed by a key that is not the baked one', () => {
    const kp = generateKeyPairSync('ed25519')
    const privDer = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    const body = manifestBody()
    const svc = new UpdateService(null as never, () => {})
    expect(verifyWith(svc, { ...body, sig: signLikeRelease(body, privDer) } as VersionManifest)).toBe(false)
  })

  it('accepts the version.json this build actually published, when one is present', () => {
    // dist/ is gitignored, so this is a local build check rather than a CI gate:
    // it proves the key on this machine matches the key baked into the binary.
    const path = join(process.cwd(), 'dist', 'version.json')
    let manifest: VersionManifest
    try {
      manifest = JSON.parse(readFileSync(path, 'utf8')) as VersionManifest
    } catch {
      return // no local release build — nothing to check
    }
    const svc = new UpdateService(null as never, () => {})
    expect(verifyWith(svc, manifest)).toBe(true)
  })
})
