import { describe, expect, it } from 'vitest'
import {
  base32Crockford,
  beaconFileName,
  dayShard,
  eventFileName,
  formatFingerprint,
  parseBeaconFileName,
  parseEventFileName,
  parseSignalFileName,
  sanitizeHostname,
  seqToBase36,
  signalFileName,
} from './ids'

describe('ids', () => {
  it('event filename round-trips and sorts byte-wise = (hlc, ctr, device)', () => {
    const n = eventFileName(1757265000123, 7, 'a1b2c3d4e5f6a7b8'.slice(0, 16), 'msg')
    expect(n).toBe('1757265000123-0007-a1b2c3d4.msg.e1')
    const p = parseEventFileName(n)!
    expect(p.hlcMs).toBe(1757265000123)
    expect(p.ctr).toBe(7)
    expect(p.deviceId8).toBe('a1b2c3d4')
    expect(p.type).toBe('msg')

    const earlier = eventFileName(1757265000123, 6, 'ffffffff', 'msg')
    expect([n, earlier].sort()[0]).toBe(earlier)
  })

  it('rejects malformed event names', () => {
    expect(parseEventFileName('junk.e1')).toBeNull()
    expect(parseEventFileName('1757265000123-0007-a1b2c3d4.nope.e1')).toBeNull()
  })

  it('beacon filename round-trips with base36 seq ordering', () => {
    const n = beaconFileName('a1b2c3d4e5f6', 46_655)
    expect(n).toBe('a1b2c3d4.00000ZZZ')
    const p = parseBeaconFileName(n)!
    expect(p.deviceId8).toBe('a1b2c3d4')
    expect(p.seq).toBe(46_655)
    expect(seqToBase36(46_656) > seqToBase36(46_655)).toBe(true)
  })

  it('signal filename round-trips', () => {
    const n = signalFileName(1757269412345, 'a3f19c2e0011deadbeef', 1, '9f31ab77aaaa', 'c04d55e1bbbb', 'offer')
    const p = parseSignalFileName(n)!
    expect(p).toMatchObject({ ms: 1757269412345, sess8: 'a3f19c2e', seq: 1, from8: '9f31ab77', to8: 'c04d55e1', type: 'offer' })
  })

  it('day shard is the UTC date', () => {
    expect(dayShard(Date.UTC(2026, 8, 7, 23, 59, 59))).toBe('2026-09-07')
  })

  it('base32 crockford excludes I L O U', () => {
    const s = base32Crockford(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]))
    expect(/[ILOU]/.test(s)).toBe(false)
  })

  it('fingerprint formats as XXXX-XXXX', () => {
    const fp = formatFingerprint(new Uint8Array(32).fill(0xab))
    expect(fp).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
  })

  it('sanitizes hostnames', () => {
    expect(sanitizeHostname('mbp-ana-1832.corp')).toBe('MBP-ANA-1832')
    expect(sanitizeHostname('Ana’s MacBook Pro.local')).toBe('ANASMACBOOKP')
  })
})
