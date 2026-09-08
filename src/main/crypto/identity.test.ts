import { describe, expect, it } from 'vitest'
import { DST } from '@shared/constants'
import {
  deviceIdFromEdPub,
  dmSharedSecret,
  fingerprintFromEdPub,
  generateIdentity,
  identityFromStored,
  importEdPub,
  signRecord,
  verifyRecord,
} from './identity'
import { deriveDmKey, dmPairToken } from './keys'

describe('identity', () => {
  const { identity: alice, stored: aliceStored } = generateIdentity()
  const { identity: bob } = generateIdentity()

  it('deviceId and fingerprint derive from the public key', () => {
    expect(alice.deviceId).toHaveLength(32)
    expect(deviceIdFromEdPub(alice.edPub)).toBe(alice.deviceId)
    expect(fingerprintFromEdPub(alice.edPub)).toBe(alice.fingerprint)
    expect(alice.fingerprint).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
  })

  it('survives store/load round-trip', () => {
    const reloaded = identityFromStored(aliceStored)
    expect(reloaded.deviceId).toBe(alice.deviceId)
    expect(reloaded.edPub).toBe(alice.edPub)
    expect(reloaded.xPub).toBe(alice.xPub)
  })

  it('signs and verifies records with domain separation', () => {
    const rec = signRecord(alice, DST.record, { t: 'msg', body: 'hi' })
    expect(rec.by).toBe(alice.deviceId)
    expect(verifyRecord(rec, DST.record, importEdPub(alice.edPub))).toBe(true)
    // wrong DST fails
    expect(verifyRecord(rec, DST.devrec, importEdPub(alice.edPub))).toBe(false)
    // wrong key fails
    expect(verifyRecord(rec, DST.record, importEdPub(bob.edPub))).toBe(false)
    // tampered payload fails
    const tampered = { ...rec, p: { t: 'msg', body: 'HI' } }
    expect(verifyRecord(tampered, DST.record, importEdPub(alice.edPub))).toBe(false)
  })

  it('DM shared secret agrees in both directions and yields the same pair key', () => {
    const sAB = dmSharedSecret(alice, bob.xPub)
    const sBA = dmSharedSecret(bob, alice.xPub)
    expect(sAB.equals(sBA)).toBe(true)
    const kA = deriveDmKey(sAB, alice.deviceId, bob.deviceId)
    const kB = deriveDmKey(sBA, bob.deviceId, alice.deviceId)
    expect(kA.equals(kB)).toBe(true)
    expect(dmPairToken(kA)).toBe(dmPairToken(kB))
  })
})
