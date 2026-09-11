import { describe, expect, it } from 'vitest'
import type { ConvId, PresenceView } from '@shared/types'
import { countPreTombstonePeers, isOlderApp } from './outdatedPeers'

function person(over: Partial<PresenceView> & { deviceId: string }): PresenceView {
  return {
    name: 'Someone',
    hostname: 'host',
    fingerprint: 'AAAA-0000',
    state: 'online',
    status: '',
    lastSeenMs: 1,
    trust: 'trusted',
    dmConv: `dm:${over.deviceId}` as ConvId,
    departed: false,
    ...over,
  }
}

describe('isOlderApp', () => {
  it('treats a missing version as older (pre-1.2, or not beaconed yet)', () => {
    expect(isOlderApp(undefined)).toBe(true)
  })

  it('compares dotted-numeric versions against the 1.2.0 floor', () => {
    expect(isOlderApp('1.1.2')).toBe(true)
    expect(isOlderApp('1.1.99')).toBe(true)
    expect(isOlderApp('1.2.0')).toBe(false)
    expect(isOlderApp('1.2.1')).toBe(false)
    expect(isOlderApp('1.10.0')).toBe(false) // numeric, not lexicographic, compare
    expect(isOlderApp('2.0.0')).toBe(false)
  })

  it('takes a custom floor', () => {
    expect(isOlderApp('1.2.0', '1.3.0')).toBe(true)
    expect(isOlderApp('1.3.0', '1.3.0')).toBe(false)
  })
})

describe('countPreTombstonePeers', () => {
  it('counts non-departed peers with no app or an app below the floor', () => {
    const presence = [
      person({ deviceId: 'a', app: '1.1.2' }),
      person({ deviceId: 'b', app: undefined }),
      person({ deviceId: 'c', app: '1.2.0' }),
      person({ deviceId: 'd', app: '1.2.3' }),
    ]
    expect(countPreTombstonePeers(presence)).toBe(2)
  })

  it('excludes departed devices — they cannot post into anything any more', () => {
    const presence = [person({ deviceId: 'a', app: undefined, departed: true })]
    expect(countPreTombstonePeers(presence)).toBe(0)
  })

  it('is zero when every present teammate is on 1.2+', () => {
    const presence = [person({ deviceId: 'a', app: '1.2.0' }), person({ deviceId: 'b', app: '1.3.5' })]
    expect(countPreTombstonePeers(presence)).toBe(0)
  })

  it('is zero with nobody else on the team folder', () => {
    expect(countPreTombstonePeers([])).toBe(0)
  })
})
