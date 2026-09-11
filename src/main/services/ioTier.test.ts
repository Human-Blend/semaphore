import { afterEach, describe, expect, it, vi } from 'vitest'
import { POLL } from '@shared/constants'
import { IoTierManager, dropsInboxMsFor, sweepMsFor, tickMsFor, type IoTier } from './ioTier'

// The tier is derived, never set, so the interesting cases are the ones where
// two signals disagree: a focused window on a machine nobody has touched for
// five minutes, a locked screen whose OS idle counter is meaningless, and the
// return from either.

afterEach(() => {
  vi.useRealTimers()
})

function rig(opts?: { idleSec?: number; visible?: boolean }) {
  let idleSec = opts?.idleSec ?? 0
  let visible = opts?.visible ?? true
  const seen: IoTier[] = []
  const m = new IoTierManager({
    getSystemIdleSec: () => idleSec,
    isWindowVisible: () => visible,
  })
  m.onChange((t) => seen.push(t))
  return {
    m,
    seen,
    setIdle(sec: number) {
      idleSec = sec
      m.sample()
    },
    setVisible(v: boolean) {
      visible = v
      m.setVisible(v)
    },
    /** The window really changed, but no event reached the manager. */
    silentlyHide() {
      visible = false
    },
  }
}

describe('io tier derivation', () => {
  it('follows window focus while someone is actually at the keyboard', () => {
    const { m } = rig()
    m.setFocused(true)
    expect(m.tier).toBe('focused')
    m.setFocused(false)
    expect(m.tier).toBe('blurred')
  })

  it('slows a focused window that nobody is typing into, but never hides it', () => {
    const r = rig()
    r.m.setFocused(true)
    r.setIdle(POLL.idleAfterMs / 1000 - 1)
    expect(r.m.tier).toBe('focused') // one second short of the threshold
    r.setIdle(POLL.idleAfterMs / 1000)
    // A focused window in front of an empty chair is still a window someone is
    // reading (or watching a screen share in). It steps down to the background
    // cadence — never to `idle`, where 15 s ticks mean typing indicators that
    // never render and messages that arrive in batches.
    expect(r.m.tier).toBe('blurred')
    expect(r.m.idleSec).toBe(POLL.idleAfterMs / 1000) // the beacon still tells the truth
    r.setIdle(0)
    expect(r.m.tier).toBe('focused') // one keystroke and it is back
  })

  it('only the unfocused reach the idle tier', () => {
    const r = rig()
    r.m.setFocused(false)
    r.setIdle(POLL.idleAfterMs / 1000)
    expect(r.m.tier).toBe('idle')
    r.m.setFocused(true) // focus IS input, so idleSec resets too
    expect(r.m.tier).toBe('focused')
  })

  it('goes idle when the window has been out of sight and unfocused long enough', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T09:00:00Z'))
    const r = rig()
    r.m.setFocused(false)
    r.setVisible(false)
    expect(r.m.tier).toBe('blurred') // hidden, but only just
    vi.setSystemTime(new Date('2026-09-10T09:00:00Z').getTime() + POLL.idleAfterMs)
    r.setIdle(5) // the person is busy in another app — the OS is not idle at all
    expect(r.m.tier).toBe('idle')
  })

  it('reconciles visibility against the window on every sample, not just on events', () => {
    // show/hide/minimize/restore are the fast path, but they are not exhaustive
    // (a window built after this manager, an event that fired before mainWindow
    // existed). A stale `visible: true` is exactly what keeps a hidden client on
    // the awake cadence forever, so the sampler asks the window itself.
    vi.useFakeTimers()
    const t0 = new Date('2026-09-10T09:00:00Z').getTime()
    vi.setSystemTime(t0)
    const r = rig()
    r.m.setFocused(false)
    r.silentlyHide() // no setVisible() call — the manager is not told
    r.setIdle(5) // sample(): the person is busy in another app, the OS is not idle
    expect(r.m.tier).toBe('blurred') // hidden as of now, so the stopwatch just started
    vi.setSystemTime(t0 + POLL.idleAfterMs)
    r.setIdle(5)
    expect(r.m.tier).toBe('idle')
  })

  it('pauses on lock and on suspend, and the OS idle counter stops mattering', () => {
    const r = rig()
    r.m.setFocused(true)
    r.m.setLocked(true)
    expect(r.m.tier).toBe('paused')
    r.setIdle(0) // sample() must not un-pause a locked screen
    expect(r.m.tier).toBe('paused')
    r.m.setLocked(false)
    expect(r.m.tier).toBe('focused') // unlocking is input; straight back to work
  })

  it('treats suspend independently of lock, so a resume under a lock stays paused', () => {
    const r = rig()
    r.m.setFocused(true)
    r.m.setLocked(true)
    r.m.setSuspended(true)
    r.m.setSuspended(false)
    expect(r.m.tier).toBe('paused')
    r.m.setLocked(false)
    expect(r.m.tier).toBe('focused')
  })

  it('announces the current tier to a listener that arrives late', () => {
    const { m } = rig()
    m.setFocused(true)
    const late: IoTier[] = []
    m.onChange((t) => late.push(t))
    expect(late).toEqual(['focused'])
  })

  it('notifies on a changed idleSec without inventing a tier change', () => {
    const r = rig()
    r.m.setFocused(false)
    const before = r.seen.length
    r.setIdle(30)
    r.setIdle(60)
    expect(r.seen.slice(before)).toEqual(['blurred', 'blurred'])
    expect(r.m.idleSec).toBe(60)
  })

  it('never reports idleness it could not measure', () => {
    const m = new IoTierManager({
      getSystemIdleSec: () => {
        throw new Error('no powerMonitor here')
      },
      isWindowVisible: () => true,
    })
    m.setFocused(false)
    m.sample()
    expect(m.idleSec).toBe(0)
    expect(m.tier).toBe('blurred')
  })

  it('stops sampling when stopped', () => {
    vi.useFakeTimers()
    let calls = 0
    const m = new IoTierManager({
      getSystemIdleSec: () => {
        calls++
        return 0
      },
      isWindowVisible: () => true,
    })
    m.start()
    expect(calls).toBe(1)
    vi.advanceTimersByTime(90_000)
    const running = calls
    expect(running).toBeGreaterThan(1)
    m.stop()
    vi.advanceTimersByTime(90_000)
    expect(calls).toBe(running)
  })
})

describe('io tier cadences', () => {
  it('gets slower at every step down and stops dead when paused', () => {
    const tiers: IoTier[] = ['focused', 'blurred', 'idle']
    for (const table of [tickMsFor, sweepMsFor, dropsInboxMsFor]) {
      const values = tiers.map((t) => table(t) as number)
      expect(values.every((v) => typeof v === 'number' && v > 0)).toBe(true)
      expect(values[0]).toBeLessThanOrEqual(values[1])
      expect(values[1]).toBeLessThanOrEqual(values[2])
      expect(table('paused')).toBeNull()
    }
  })

  it('maps each tier to the constant the contract names', () => {
    expect(tickMsFor('focused')).toBe(POLL.focusedMs)
    expect(tickMsFor('blurred')).toBe(POLL.backgroundMs)
    expect(tickMsFor('idle')).toBe(POLL.idleMs)
    expect(sweepMsFor('focused')).toBe(POLL.sweepFocusedMs)
    expect(sweepMsFor('blurred')).toBe(POLL.sweepBlurredMs)
    expect(sweepMsFor('idle')).toBe(POLL.sweepIdleMs)
    expect(dropsInboxMsFor('focused')).toBe(POLL.dropsInboxMs)
    expect(dropsInboxMsFor('idle')).toBe(POLL.dropsInboxIdleMs)
  })
})
