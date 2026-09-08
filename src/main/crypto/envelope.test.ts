import { describe, expect, it } from 'vitest'
import { randomBytes, generateKeyPairSync, createPublicKey } from 'node:crypto'
import {
  buildAad,
  decryptRecord,
  encryptRecord,
  openSealedRecord,
  recordKid,
  sealRecord,
} from './envelope'

const rootKey = randomBytes(32)
const aad = buildAad('e1', 'channels/ABCDE/events/2026-09-07/x.msg.e1', 'x')

describe('SFC1 keyed records', () => {
  it('round-trips', () => {
    const pt = Buffer.from(JSON.stringify({ hello: 'world' }))
    const rec = encryptRecord(rootKey, 'e1/conv/ABCDE', pt, aad)
    expect(recordKid(rec)).toBe('e1/conv/ABCDE')
    expect(decryptRecord(rec, rootKey, aad).toString()).toBe(pt.toString())
  })

  it('fails with a different AAD (moved/renamed file)', () => {
    const rec = encryptRecord(rootKey, 'k', Buffer.from('x'), aad)
    const otherAad = buildAad('e1', 'channels/OTHER/events/2026-09-07/x.msg.e1', 'x')
    expect(() => decryptRecord(rec, rootKey, otherAad)).toThrow()
  })

  it('fails with the wrong key', () => {
    const rec = encryptRecord(rootKey, 'k', Buffer.from('x'), aad)
    expect(() => decryptRecord(rec, randomBytes(32), aad)).toThrow()
  })

  it('fails on ciphertext tampering', () => {
    const rec = encryptRecord(rootKey, 'k', Buffer.from('payload-bytes'), aad)
    rec[rec.length - 20] ^= 0x01
    expect(() => decryptRecord(rec, rootKey, aad)).toThrow()
  })

  it('two encryptions of the same plaintext differ (fresh salt+nonce)', () => {
    const a = encryptRecord(rootKey, 'k', Buffer.from('same'), aad)
    const b = encryptRecord(rootKey, 'k', Buffer.from('same'), aad)
    expect(a.equals(b)).toBe(false)
  })
})

describe('SFC1 sealed records', () => {
  const recipient = generateKeyPairSync('x25519')

  it('round-trips to the right recipient', () => {
    const rec = sealRecord(recipient.publicKey, 'seal/aabbccdd', Buffer.from('secret'), aad)
    expect(openSealedRecord(rec, recipient.privateKey, aad).toString()).toBe('secret')
  })

  it('cannot be opened by another device', () => {
    const rec = sealRecord(recipient.publicKey, 'seal/aabbccdd', Buffer.from('secret'), aad)
    const other = generateKeyPairSync('x25519')
    expect(() => openSealedRecord(rec, other.privateKey, aad)).toThrow()
  })

  it('binds to AAD', () => {
    const rec = sealRecord(recipient.publicKey, 'k', Buffer.from('secret'), aad)
    const otherAad = buildAad('e1', 'drops/other', 'y')
    expect(() => openSealedRecord(rec, recipient.privateKey, otherAad)).toThrow()
  })

  it('recipient public key export/import round-trips', () => {
    const raw = (recipient.publicKey.export({ format: 'jwk' }) as { x: string }).x
    const imported = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw }, format: 'jwk' })
    const rec = sealRecord(imported, 'k', Buffer.from('via-raw'), aad)
    expect(openSealedRecord(rec, recipient.privateKey, aad).toString()).toBe('via-raw')
  })
})
