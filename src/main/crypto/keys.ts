import { createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { HKDF_INFO, KDF } from '@shared/constants'

// Team key hierarchy. scrypt over Argon2: every maintained Argon2 binding is a
// native addon (banned), and pure-JS ports are so slow the parameters would
// have to be weakened below well-tuned scrypt. N=2^17/r=8 → 128 MiB per guess.

export function deriveTmk(passphrase: string, teamSalt: Buffer): Buffer {
  return scryptSync(Buffer.from(passphrase.normalize('NFKD'), 'utf8'), teamSalt, 32, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: KDF.maxmem, // must exceed 128*N*r; Node's 32 MiB default throws
  })
}

/** 16-byte passphrase check value stored in protocol.json (base64). */
export function computeCheck(tmk: Buffer, teamSalt: Buffer): Buffer {
  const checkKey = Buffer.from(hkdfSync('sha256', tmk, teamSalt, HKDF_INFO.check, 32))
  return createHmac('sha256', checkKey).update(teamSalt).digest().subarray(0, 16)
}

export function verifyCheck(tmk: Buffer, teamSalt: Buffer, checkB64: string): boolean {
  const expected = computeCheck(tmk, teamSalt)
  const actual = Buffer.from(checkB64, 'base64')
  return actual.length === expected.length && timingSafeEqual(expected, actual)
}

export function hkdf(ikm: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, 32))
}

/**
 * The full key set derived from one epoch's TMK.
 * Directory tokens (K_meta) always derive from the EPOCH 1 TMK so channel/DM
 * directories never move on passphrase rotation — every member can compute
 * TMK_1 via the wrapped epoch chain.
 */
export interface TeamKeys {
  epoch: number
  tmk: Buffer
  kMeta: Buffer // dir tokens + config/devices/channel-meta encryption
  kPres: Buffer // beacons
}

export function deriveTeamKeys(epoch: number, tmk: Buffer, tmk1: Buffer, teamSalt: Buffer): TeamKeys {
  return {
    epoch,
    tmk,
    kMeta: hkdf(tmk1, teamSalt, HKDF_INFO.meta),
    kPres: hkdf(tmk, teamSalt, `smbchat/v1/e${epoch}/presence`),
  }
}

export function deriveConvKey(tmk: Buffer, teamSalt: Buffer, epoch: number, channelId: string): Buffer {
  return hkdf(tmk, teamSalt, `smbchat/v1/e${epoch}/conv/${channelId}`)
}

/** Opaque directory token for a channel (stable across epochs). */
export function convToken(kMeta: Buffer, channelId: string): string {
  const mac = createHmac('sha256', kMeta).update(`conv:${channelId}`).digest()
  return b32(mac).slice(0, 20)
}

/** DM root key from an X25519 shared secret (both sides derive identically). */
export function deriveDmKey(sharedSecret: Buffer, deviceIdA: string, deviceIdB: string): Buffer {
  const [lo, hi] = [deviceIdA, deviceIdB].sort()
  return hkdf(sharedSecret, Buffer.from(`${lo}|${hi}`, 'utf8'), HKDF_INFO.dmRoot)
}

/** Opaque DM directory token — only the two participants can compute it. */
export function dmPairToken(dmKey: Buffer): string {
  const mac = createHmac('sha256', dmKey).update(HKDF_INFO.dmDirToken).digest()
  return b32(mac).slice(0, 20)
}

/**
 * Opaque private-group directory token (1.2). Derived from the group's EPOCH-1
 * key — like `kMeta` for channels, it must survive every rekey, or a removal
 * would move the whole log to a new directory. Only someone who was handed a
 * group key can compute it, so `groups/` tells a non-member nothing: not the
 * name, not the members, not even that a given group exists.
 */
export function groupDirToken(groupKey1: Buffer): string {
  const mac = createHmac('sha256', groupKey1).update(HKDF_INFO.grpDirToken).digest()
  return b32(mac).slice(0, 20)
}

/** A fresh 32-byte group key (epoch 1, or a rotation). */
export function newGroupKey(): Buffer {
  return randomBytes(32)
}

export function newTeamSalt(): Buffer {
  return randomBytes(KDF.saltBytes)
}

export function newBlobKey(): Buffer {
  return randomBytes(32)
}

// Crockford base32, duplicated tiny to keep this module dependency-light
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function b32(bytes: Buffer): string {
  let out = ''
  let bits = 0
  let acc = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return out
}
