import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto'
import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import { canonicalJson } from '@shared/canonicalJson'
import { formatFingerprint } from '@shared/ids'
import type { SignedRecord } from '@shared/types'

// Per-device identity: Ed25519 (signing) + X25519 (sealing/DM agreement).
// deviceId = hex(SHA-256(edPubRaw)[0..16]) — unforgeable by construction since
// every write is signature-checked against the registered key for that id.

export interface DeviceIdentity {
  deviceId: string
  edPub: string // base64url raw
  xPub: string // base64url raw
  edPriv: KeyObject
  xPriv: KeyObject
  fingerprint: string // "Q7RC-2MZE"
}

export interface StoredIdentity {
  v: 1
  edPrivPkcs8: string // base64 DER
  xPrivPkcs8: string
}

function rawPub(pub: KeyObject): Buffer {
  const jwk = pub.export({ format: 'jwk' }) as { x?: string }
  if (!jwk.x) throw new Error('not an OKP key')
  return Buffer.from(jwk.x, 'base64url')
}

export function generateIdentity(): { identity: DeviceIdentity; stored: StoredIdentity } {
  const ed = generateKeyPairSync('ed25519')
  const x = generateKeyPairSync('x25519')
  const stored: StoredIdentity = {
    v: 1,
    edPrivPkcs8: (ed.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64'),
    xPrivPkcs8: (x.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64'),
  }
  return { identity: identityFromStored(stored), stored }
}

export function identityFromStored(stored: StoredIdentity): DeviceIdentity {
  const edPriv = createPrivateKey({
    key: Buffer.from(stored.edPrivPkcs8, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  const xPriv = createPrivateKey({
    key: Buffer.from(stored.xPrivPkcs8, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  const edPubKey = createPublicKey(edPriv)
  const xPubKey = createPublicKey(xPriv)
  const edPubRaw = rawPub(edPubKey)
  const hash = createHash('sha256').update(edPubRaw).digest()
  return {
    deviceId: hash.subarray(0, 16).toString('hex'),
    edPub: edPubRaw.toString('base64url'),
    xPub: rawPub(xPubKey).toString('base64url'),
    edPriv,
    xPriv,
    fingerprint: formatFingerprint(hash),
  }
}

export function importEdPub(rawB64url: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: rawB64url }, format: 'jwk' })
}

export function deviceIdFromEdPub(rawB64url: string): string {
  return createHash('sha256').update(Buffer.from(rawB64url, 'base64url')).digest().subarray(0, 16).toString('hex')
}

export function fingerprintFromEdPub(rawB64url: string): string {
  return formatFingerprint(createHash('sha256').update(Buffer.from(rawB64url, 'base64url')).digest())
}

// ---------------------------------------------------------------------------
// Sign / verify with domain separation

function sigInput(dst: string, payload: unknown): Buffer {
  return Buffer.concat([Buffer.from(dst, 'ascii'), Buffer.from([0]), Buffer.from(canonicalJson(payload), 'utf8')])
}

export function signRecord<T>(identity: DeviceIdentity, dst: string, payload: T): SignedRecord<T> {
  const sig = edSign(null, sigInput(dst, payload), identity.edPriv)
  return { p: payload, by: identity.deviceId, sig: sig.toString('base64') }
}

export function verifyRecord(record: SignedRecord, dst: string, edPub: KeyObject): boolean {
  try {
    return edVerify(null, sigInput(dst, record.p), edPub, Buffer.from(record.sig, 'base64'))
  } catch {
    return false
  }
}

/** X25519 shared secret with another device's published xPub. */
export function dmSharedSecret(identity: DeviceIdentity, theirXPubB64url: string): Buffer {
  const theirPub = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: theirXPubB64url }, format: 'jwk' })
  return diffieHellman({ privateKey: identity.xPriv, publicKey: theirPub })
}

// ---------------------------------------------------------------------------
// Machine fingerprint (secondary deterrent — no native modules)

export async function gatherMachineIdHash(): Promise<string | null> {
  const run = (cmd: string, args: string[]) =>
    new Promise<string | null>((res) => {
      execFile(cmd, args, { timeout: 5000 }, (err, stdout) => res(err ? null : stdout))
    })
  try {
    let guid: string | null = null
    if (process.platform === 'darwin') {
      const out = await run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
      guid = out?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? null
    } else if (process.platform === 'win32') {
      const out = await run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'])
      guid = out?.match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1] ?? null
    }
    if (!guid) return null
    return createHash('sha256').update(`smbchat-mid${guid}`).digest('hex')
  } catch {
    return null // "fingerprint unavailable" — warn, never refuse to run
  }
}

export function currentHostname(): string {
  return hostname()
}
