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

// ---------------------------------------------------------------------------
// Peer-announced versions (1.2)
//
// A teammate's beacon carries their Chat version. The rule is deliberately
// narrow: only a strictly newer *valid* semver counts, only the first sighting
// of each version raises anything, and the signed manifest always wins — the
// peer banner exists purely for the window where someone has the new build and
// the zip has not reached the folder yet.

interface FakeShare {
  file: string | null
  mtime: number
  stats: number
  reads: number
  /** Set to stall the next share read mid-check (a slow SMB round trip). */
  hold?: Promise<void> | null
}

/** A Session stub with just the two share reads UpdateService performs. */
function fakeSession(share: FakeShare) {
  return {
    io: {
      statMaybe: async (): Promise<{ mtimeMs: number; size: number } | null> => {
        share.stats++
        if (share.hold) await share.hold
        return share.file === null ? null : { mtimeMs: share.mtime, size: share.file.length }
      },
      readMaybe: async (): Promise<Buffer | null> => {
        share.reads++
        return share.file === null ? null : Buffer.from(share.file)
      },
    },
  } as never
}

function peerRig(mine = '1.1.2', manifestJson: string | null = null) {
  const share: FakeShare = { file: manifestJson, mtime: 1, stats: 0, reads: 0, hold: null }
  const pushed: { version: string; source?: string; notes: string; zipAvailable?: boolean; peerName?: string }[] = []
  const svc = new UpdateService(
    fakeSession(share),
    (msg) => {
      if (msg.kind === 'update') pushed.push(msg.update)
    },
    () => mine,
  )
  // The signature path has its own tests above; here the question is the
  // decision the service makes once a manifest verifies.
  ;(svc as unknown as { verify(): boolean }).verify = () => true
  return { svc, share, pushed }
}

const manifestFor = (version: string) => JSON.stringify({ ...manifestBody({ version }), sig: 'x' })

describe('peer-announced updates', () => {
  it('ignores a teammate on an older or equal build', async () => {
    const { svc, pushed, share } = peerRig('1.1.2')
    svc.notePeerVersion('1.1.1', 'Ana')
    svc.notePeerVersion('1.1.2', 'Ben')
    await vi.waitFor(() => expect(share.stats).toBe(0))
    expect(pushed).toEqual([])
    svc.stop()
  })

  it('ignores a version string that is not semver', async () => {
    const { svc, pushed, share } = peerRig('1.1.2')
    svc.notePeerVersion('next', 'Ana')
    svc.notePeerVersion('', 'Ben')
    expect(share.stats).toBe(0)
    expect(pushed).toEqual([])
    svc.stop()
  })

  it('shows the peer banner when the zip is not in the apps folder yet', async () => {
    const { svc, pushed } = peerRig('1.1.2', null)
    svc.notePeerVersion('1.2.0', 'Ana')
    await vi.waitFor(() => expect(pushed).toHaveLength(1))
    expect(pushed[0]).toMatchObject({
      version: '1.2.0',
      source: 'peer',
      peerName: 'Ana',
      zipAvailable: false,
      blocking: false,
    })
    expect(pushed[0].notes).toBe("Ana is already on Chat 1.2.0. The zip isn't in the apps folder yet.")
    svc.stop()
  })

  it('prefers the signed manifest when it already covers that version', async () => {
    const { svc, pushed } = peerRig('1.1.2', manifestFor('1.2.0'))
    svc.notePeerVersion('1.2.0', 'Ana')
    await vi.waitFor(() => expect(pushed).toHaveLength(1))
    expect(pushed[0]).toMatchObject({ version: '1.2.0', source: 'manifest', zipAvailable: true })
    svc.stop()
  })

  it('still says "peer" when the manifest on the share is older than the peer', async () => {
    // Someone hand-built 1.3.0 while apps/ still advertises 1.2.0: the manifest
    // banner is pushed for what IS copyable, and the peer banner for what isn't.
    const { svc, pushed } = peerRig('1.1.2', manifestFor('1.2.0'))
    svc.notePeerVersion('1.3.0', 'Ana')
    await vi.waitFor(() => expect(pushed).toHaveLength(2))
    expect(pushed[0]).toMatchObject({ version: '1.2.0', source: 'manifest' })
    expect(pushed[1]).toMatchObject({ version: '1.3.0', source: 'peer' })
    svc.stop()
  })

  it('announces each version once, however many teammates are on it', async () => {
    const { svc, pushed, share } = peerRig('1.1.2', null)
    svc.notePeerVersion('1.2.0', 'Ana')
    await vi.waitFor(() => expect(pushed).toHaveLength(1))
    const statsAfterFirst = share.stats
    for (const who of ['Ben', 'Cat', 'Dee']) svc.notePeerVersion('1.2.0', who)
    svc.notePeerVersion('1.2.0', 'Ana')
    await new Promise((r) => setTimeout(r, 10))
    expect(pushed).toHaveLength(1)
    expect(share.stats).toBe(statsAfterFirst) // no re-check storm either
    // A genuinely newer sighting is a different story.
    svc.notePeerVersion('1.3.0', 'Ben')
    await vi.waitFor(() => expect(pushed).toHaveLength(2))
    expect(pushed[1]).toMatchObject({ version: '1.3.0', source: 'peer', peerName: 'Ben' })
    svc.stop()
  })

  it('flips to the manifest banner when the release lands within the re-check window', async () => {
    vi.useFakeTimers()
    try {
      const { svc, share, pushed } = peerRig('1.1.2', null)
      svc.notePeerVersion('1.2.0', 'Ana')
      await vi.advanceTimersByTimeAsync(1)
      expect(pushed).toHaveLength(1)
      expect(pushed[0].source).toBe('peer')

      // The zip and its signed manifest finish copying a minute later.
      share.file = manifestFor('1.2.0')
      share.mtime = 2
      await vi.advanceTimersByTimeAsync(61_000)
      expect(pushed).toHaveLength(2)
      expect(pushed[1]).toMatchObject({ version: '1.2.0', source: 'manifest', zipAvailable: true })

      // …and stops re-checking once it has what it was waiting for.
      const settled = share.stats
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(share.stats).toBe(settled)
      svc.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('an in-flight re-check never clears the timer a newer sighting installed', async () => {
    // Two teammates, two versions, one `this.recheck` slot. The first timer's
    // callback is inside its share read when the second sighting replaces the
    // slot — and it used to clear whatever it found there on the way out,
    // killing the newer timer and leaving that version stuck on the peer banner
    // for good.
    vi.useFakeTimers()
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 30; i++) await Promise.resolve()
    }
    try {
      const { svc, share, pushed } = peerRig('1.1.2', null)
      svc.notePeerVersion('1.2.0', 'Ana')
      await vi.advanceTimersByTimeAsync(1)
      expect(pushed).toMatchObject([{ version: '1.2.0', source: 'peer' }])

      // Ana's re-check fires and stalls inside the share read. The advance is
      // the synchronous one on purpose: it starts the callback and hands
      // control back while that callback is still inside its await.
      let release: () => void = () => {}
      share.hold = new Promise<void>((r) => {
        release = r
      })
      vi.advanceTimersByTime(60_000)
      await flush()
      expect(share.stats).toBeGreaterThan(1) // it really did start a share read

      // Meanwhile Ana's zip lands and Ben turns up on something newer still.
      share.hold = null
      share.file = manifestFor('1.2.0')
      share.mtime = 2
      svc.notePeerVersion('1.3.0', 'Ben')
      await flush()
      expect(pushed).toMatchObject([
        { version: '1.2.0', source: 'peer' },
        { version: '1.2.0', source: 'manifest' },
        { version: '1.3.0', source: 'peer' },
      ])

      // Now Ana's stalled callback finishes and sees what it was waiting for.
      release()
      await flush()

      // Ana's timer is done (it got its manifest) and Ben's is the live one.
      // The bug read the *slot* instead of its own handle, so it cleared Ben's
      // timer and kept its own running: the slot went null and the only thing
      // still statting the share was a timer nobody could stop.
      const live = (svc as unknown as { recheck: NodeJS.Timeout | null }).recheck
      expect(live).not.toBeNull()

      // Ben's timer must still be alive: when 1.3.0 lands, the banner flips.
      share.file = manifestFor('1.3.0')
      share.mtime = 3
      await vi.advanceTimersByTimeAsync(60_000)
      await flush()
      expect(pushed.at(-1)).toMatchObject({ version: '1.3.0', source: 'manifest', zipAvailable: true })
      svc.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop() lets go of both timers', async () => {
    vi.useFakeTimers()
    try {
      const { svc, share, pushed } = peerRig('1.1.2', null)
      svc.start() // the periodic manifest check
      svc.notePeerVersion('1.2.0', 'Ana')
      await vi.advanceTimersByTimeAsync(1)
      expect(pushed).toHaveLength(1)
      svc.stop()
      const settled = share.stats
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(share.stats).toBe(settled)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up re-checking after ten minutes rather than statting forever', async () => {
    vi.useFakeTimers()
    try {
      const { svc, share, pushed } = peerRig('1.1.2', null)
      svc.notePeerVersion('1.2.0', 'Ana')
      await vi.advanceTimersByTimeAsync(1)
      expect(pushed).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(11 * 60_000)
      const afterWindow = share.stats
      expect(afterWindow).toBeLessThanOrEqual(12) // ~one stat a minute, then silence
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(share.stats).toBe(afterWindow)
      svc.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
