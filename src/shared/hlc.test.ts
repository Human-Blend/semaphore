import { describe, expect, it } from 'vitest'
import { hlcObserve, hlcTick, newHlcState } from './hlc'
import { HLC } from './constants'

describe('hlc', () => {
  it('advances with wall clock and resets ctr', () => {
    const s = newHlcState()
    expect(hlcTick(s, 1000)).toEqual({ ms: 1000, ctr: 0 })
    expect(hlcTick(s, 2000)).toEqual({ ms: 2000, ctr: 0 })
  })

  it('increments ctr when wall clock stalls or goes backwards', () => {
    const s = newHlcState()
    hlcTick(s, 1000)
    expect(hlcTick(s, 1000)).toEqual({ ms: 1000, ctr: 1 })
    expect(hlcTick(s, 900)).toEqual({ ms: 1000, ctr: 2 })
  })

  it('a reply sorts after an observed future event', () => {
    const s = newHlcState()
    hlcTick(s, 1000)
    hlcObserve(s, 5000, 1000) // remote event from a faster clock
    const t = hlcTick(s, 1001)
    expect(t.ms).toBeGreaterThanOrEqual(5000)
  })

  it('caps the ratchet at maxSkewAheadMs and reports the violation', () => {
    const s = newHlcState()
    const now = 1_000_000
    const flagged = hlcObserve(s, now + HLC.maxSkewAheadMs + 60_000, now)
    expect(flagged).toBe(true)
    expect(s.lastMs).toBe(now + HLC.maxSkewAheadMs)
  })

  it('spills into next ms after 10k events in one ms', () => {
    const s = newHlcState()
    for (let i = 0; i < 10_001; i++) hlcTick(s, 1000)
    expect(s.lastMs).toBe(1001)
  })
})
