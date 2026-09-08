import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto'
import { AAD_PREFIX, HKDF_INFO } from '@shared/constants'

// SFC1 — single-shot authenticated record. Layout (big-endian):
//   magic "SFC1" | version 0x01 | suite | kidLen u16 | kid | [ephPub 32B if sealed]
//   | keySalt 16B | nonce 12B | ciphertext | gcmTag 16B
// suite 0x01 = AES-256-GCM under a caller-provided root key (per-file key via
// HKDF with the random keySalt — every file gets a unique AES key, so the
// 96-bit random nonce carries zero collision risk at any message volume).
// suite 0x03 = sealed to a device: ephemeral X25519 → HKDF → AES-256-GCM.
//
// AAD binds ciphertext to where it lives: "smbchat/v1|<scope>|<relPath>|<objectId>".
// A file renamed, moved across conversations, or replayed under a new name
// fails GCM authentication.

const MAGIC = Buffer.from('SFC1', 'ascii')
const VERSION = 0x01
const SUITE_KEYED = 0x01
const SUITE_SEALED = 0x03
const SALT_LEN = 16
const NONCE_LEN = 12
const TAG_LEN = 16
const EPH_LEN = 32

export function buildAad(scope: string, relPath: string, objectId: string): Buffer {
  return Buffer.from(`${AAD_PREFIX}|${scope}|${relPath}|${objectId}`, 'utf8')
}

function deriveFileKey(rootKey: Buffer, keySalt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', rootKey, keySalt, HKDF_INFO.file, 32))
}

export function encryptRecord(rootKey: Buffer, kid: string, plaintext: Buffer, aad: Buffer): Buffer {
  const kidBuf = Buffer.from(kid, 'ascii')
  const keySalt = randomBytes(SALT_LEN)
  const nonce = randomBytes(NONCE_LEN)
  const fileKey = deriveFileKey(rootKey, keySalt)
  const cipher = createCipheriv('aes-256-gcm', fileKey, nonce)
  cipher.setAAD(aad)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  const head = Buffer.alloc(4 + 1 + 1 + 2)
  MAGIC.copy(head, 0)
  head[4] = VERSION
  head[5] = SUITE_KEYED
  head.writeUInt16BE(kidBuf.length, 6)
  return Buffer.concat([head, kidBuf, keySalt, nonce, ct, tag])
}

export interface ParsedRecord {
  suite: number
  kid: string
  /** Present only for sealed records. */
  ephPub?: Buffer
  keySalt: Buffer
  nonce: Buffer
  ct: Buffer
  tag: Buffer
}

export function parseRecord(buf: Buffer): ParsedRecord {
  if (buf.length < 8 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('SFC1: bad magic')
  if (buf[4] !== VERSION) throw new Error(`SFC1: unsupported version ${buf[4]}`)
  const suite = buf[5]
  if (suite !== SUITE_KEYED && suite !== SUITE_SEALED) throw new Error(`SFC1: unknown suite ${suite}`)
  const kidLen = buf.readUInt16BE(6)
  let off = 8
  const kid = buf.subarray(off, off + kidLen).toString('ascii')
  off += kidLen
  let ephPub: Buffer | undefined
  if (suite === SUITE_SEALED) {
    ephPub = buf.subarray(off, off + EPH_LEN)
    off += EPH_LEN
  }
  const keySalt = buf.subarray(off, off + SALT_LEN)
  off += SALT_LEN
  const nonce = buf.subarray(off, off + NONCE_LEN)
  off += NONCE_LEN
  if (buf.length < off + TAG_LEN) throw new Error('SFC1: truncated')
  const ct = buf.subarray(off, buf.length - TAG_LEN)
  const tag = buf.subarray(buf.length - TAG_LEN)
  return { suite, kid, ephPub, keySalt, nonce, ct, tag }
}

/** Peek the kid without decrypting (key routing). */
export function recordKid(buf: Buffer): string {
  return parseRecord(buf).kid
}

export function decryptRecord(buf: Buffer, rootKey: Buffer, aad: Buffer): Buffer {
  const r = parseRecord(buf)
  if (r.suite !== SUITE_KEYED) throw new Error('SFC1: not a keyed record')
  const fileKey = deriveFileKey(rootKey, Buffer.from(r.keySalt))
  const decipher = createDecipheriv('aes-256-gcm', fileKey, r.nonce)
  decipher.setAAD(aad)
  decipher.setAuthTag(r.tag)
  return Buffer.concat([decipher.update(r.ct), decipher.final()])
}

// ---------------------------------------------------------------------------
// Sealed records (X25519 ephemeral-static → HKDF → AES-256-GCM)

function rawX25519Pub(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { x?: string }
  if (!jwk.x) throw new Error('not an OKP public key')
  return Buffer.from(jwk.x, 'base64url')
}

export function importX25519Pub(rawB64url: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: rawB64url }, format: 'jwk' })
}

export function sealRecord(recipientXPub: KeyObject, kid: string, plaintext: Buffer, aad: Buffer): Buffer {
  const eph = generateKeyPairSync('x25519')
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipientXPub })
  const ephPubRaw = rawX25519Pub(eph.publicKey)
  const key = Buffer.from(hkdfSync('sha256', shared, ephPubRaw, HKDF_INFO.seal, 32))
  const kidBuf = Buffer.from(kid, 'ascii')
  const keySalt = randomBytes(SALT_LEN) // uniform layout; HKDF above already uses ephPub as salt
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  const head = Buffer.alloc(8)
  MAGIC.copy(head, 0)
  head[4] = VERSION
  head[5] = SUITE_SEALED
  head.writeUInt16BE(kidBuf.length, 6)
  return Buffer.concat([head, kidBuf, ephPubRaw, keySalt, nonce, ct, tag])
}

export function openSealedRecord(buf: Buffer, myXPriv: KeyObject, aad: Buffer): Buffer {
  const r = parseRecord(buf)
  if (r.suite !== SUITE_SEALED || !r.ephPub) throw new Error('SFC1: not a sealed record')
  const ephPubKey = importX25519Pub(Buffer.from(r.ephPub).toString('base64url'))
  const shared = diffieHellman({ privateKey: myXPriv, publicKey: ephPubKey })
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(r.ephPub), HKDF_INFO.seal, 32))
  const decipher = createDecipheriv('aes-256-gcm', key, r.nonce)
  decipher.setAAD(aad)
  decipher.setAuthTag(r.tag)
  return Buffer.concat([decipher.update(r.ct), decipher.final()])
}
