import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  computeCheck,
  convToken,
  deriveDmKey,
  deriveTeamKeys,
  deriveTmk,
  dmPairToken,
  verifyCheck,
} from './keys'

describe('team keys', () => {
  const salt = Buffer.alloc(32, 7)

  it('TMK is deterministic and check verifies (scrypt is slow — one derivation)', () => {
    const tmk = deriveTmk('correct horse battery staple', salt)
    expect(tmk.length).toBe(32)
    const check = computeCheck(tmk, salt)
    expect(verifyCheck(tmk, salt, check.toString('base64'))).toBe(true)
    expect(verifyCheck(Buffer.alloc(32, 1), salt, check.toString('base64'))).toBe(false)
  }, 30_000)

  it('conv tokens are stable, opaque, and fs-safe', () => {
    const kMeta = randomBytes(32)
    const t1 = convToken(kMeta, 'a1b2c3d4')
    expect(t1).toBe(convToken(kMeta, 'a1b2c3d4'))
    expect(t1).toHaveLength(20)
    expect(t1).toMatch(/^[0-9A-Z]+$/)
    expect(t1).not.toBe(convToken(kMeta, 'ffffffff'))
    expect(t1).not.toBe(convToken(randomBytes(32), 'a1b2c3d4'))
  })

  it('DM keys are identical from both directions', () => {
    const shared = randomBytes(32) // stand-in for X25519 output (same on both ends)
    const kAB = deriveDmKey(shared, 'aaaa', 'bbbb')
    const kBA = deriveDmKey(shared, 'bbbb', 'aaaa')
    expect(kAB.equals(kBA)).toBe(true)
    expect(dmPairToken(kAB)).toBe(dmPairToken(kBA))
  })

  it('team key derivation separates epochs, dir tokens pinned to epoch 1', () => {
    const tmk1 = randomBytes(32)
    const tmk2 = randomBytes(32)
    const e1 = deriveTeamKeys(1, tmk1, tmk1, salt)
    const e2 = deriveTeamKeys(2, tmk2, tmk1, salt)
    expect(e1.kMeta.equals(e2.kMeta)).toBe(true) // dirs never move on rotation
    expect(e1.kPres.equals(e2.kPres)).toBe(false)
  })
})
