import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ShareIo } from './shareIo'

// The I/O budget (1.2) is only as trustworthy as the counter behind it, and the
// counter has exactly two jobs it can get wrong: counting a publish as the
// three syscalls it really is, and letting a busy minute linger in the trailing
// window forever. Both are pinned here.

const io = (): ShareIo => new ShareIo(mkdtempSync(join(tmpdir(), 'sem-io-')))
const buf = (s: string): Buffer => Buffer.from(s, 'utf8')

afterEach(() => {
  vi.useRealTimers()
})

describe('share I/O counter', () => {
  it('counts a publish as one logical op — mkdir, write and rename are not three', async () => {
    const s = io()
    await s.publish('a/b/c.e1', buf('x'))
    expect(s.stats().total).toBe(1)
    expect(s.stats().byOp).toEqual({ publish: 1 })
  })

  it('adds exactly one stat when a publish calibrates the share clock', async () => {
    const s = io()
    await s.publish('a/one.e1', buf('x'), { calibrate: true })
    expect(s.stats().byOp).toEqual({ publish: 1, stat: 1 })
    await s.publish('a/two.e1', buf('x'))
    expect(s.stats().byOp).toEqual({ publish: 2, stat: 1 })
  })

  it('counts every primitive under its own name', async () => {
    const s = io()
    await s.ensureDir('d')
    await s.publish('d/f.e1', buf('hello'))
    await s.read('d/f.e1')
    await s.readMaybe('d/f.e1')
    await s.list('d')
    // 'd', not '': the root is not a share-relative path, and abs() refuses one.
    await s.listDirs('d')
    await s.statMaybe('d/f.e1')
    await s.delete('d/f.e1')
    await s.probe()
    expect(s.stats().byOp).toEqual({ mkdir: 1, publish: 1, read: 2, readdir: 2, stat: 2, delete: 1 })
    expect(s.stats().total).toBe(9)
  })

  it('counts a miss: an absent file still costs a round trip', async () => {
    const s = io()
    expect(await s.readMaybe('nope.e1')).toBeNull()
    expect(await s.list('nope')).toEqual([])
    expect(await s.statMaybe('nope.e1')).toBeNull()
    expect(s.stats().total).toBe(3)
  })

  it('ages ops out of the trailing minute but never out of the total', async () => {
    const s = io()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'))
    for (let i = 0; i < 5; i++) await s.publish(`x${i}.e1`, buf('x'))

    expect(s.stats().lastMinute).toBe(5)
    expect(s.stats().total).toBe(5)

    vi.setSystemTime(new Date('2026-09-10T12:00:30Z'))
    await s.publish('later.e1', buf('x'))
    expect(s.stats().lastMinute).toBe(6) // both bursts are inside the window

    vi.setSystemTime(new Date('2026-09-10T12:01:05Z')) // first burst is 65 s old
    expect(s.stats().lastMinute).toBe(1)
    expect(s.stats().total).toBe(6)

    vi.setSystemTime(new Date('2026-09-10T12:05:00Z'))
    expect(s.stats().lastMinute).toBe(0)
    expect(s.stats().ratePerSec).toBe(0)
    expect(s.stats().total).toBe(6)
  })

  it('reuses a ring slot after a full minute instead of double counting it', async () => {
    const s = io()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'))
    await s.publish('a.e1', buf('x'))
    // Same second-of-minute, one minute later: the slot must be recycled, not
    // added to, or a steady 1 op/min would read as an ever-growing rate.
    vi.setSystemTime(new Date('2026-09-10T12:01:00Z'))
    await s.publish('b.e1', buf('x'))
    expect(s.stats().lastMinute).toBe(1)
    expect(s.stats().total).toBe(2)
  })

  it('reports a rate over the history it actually has, not a padded minute', async () => {
    const s = io()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'))
    s.resetStats()
    vi.setSystemTime(new Date('2026-09-10T12:00:10Z'))
    for (let i = 0; i < 20; i++) await s.publish(`y${i}.e1`, buf('x'))
    // 20 ops in the 10 s this counter has existed is 2/s — not 20/60.
    expect(s.stats().ratePerSec).toBe(2)
  })

  it('resetStats clears the history so a test can measure a steady state', async () => {
    const s = io()
    await s.publish('a.e1', buf('x'))
    s.resetStats()
    expect(s.stats()).toMatchObject({ total: 0, lastMinute: 0, byOp: {} })
    await s.publish('b.e1', buf('x'))
    expect(s.stats().total).toBe(1)
  })
})

// Several share-relative paths are built from ids that crossed the bridge — a
// live board's sessionId (1.3) and a screen session's (1.2) are both path
// segments. The services validate them, and this is the floor under all of them
// so a future caller cannot reintroduce the hole by forgetting to.
describe('share paths', () => {
  it('refuses a path that could leave the share root', async () => {
    const s = io()
    for (const bad of [
      '..',
      'boards/../../etc/passwd',
      'boards/..',
      'screens/./frames',
      'boards//frame',
      'boards/sess/',
      '/etc/passwd',
      'boards\\..\\..\\secret',
    ]) {
      expect(() => s.abs(bad)).toThrow('unsafe share path')
    }
    // And the ordinary shapes still resolve, including the dot-prefixed health
    // probe name onboarding writes at the root.
    expect(s.abs('boards/0123456789abcdef/ab12cd34.00000000')).toContain('boards')
    expect(s.abs('.health-deadbeef')).toContain('.health-deadbeef')
    // The empty path is the team root itself (ensureDir('') on first run).
    expect(s.abs('')).toBe(s.abs('boards').replace(/[\\/]boards$/, ''))
    // Every primitive goes through it, so a traversal cannot be smuggled in via
    // one of them either.
    await expect(s.publish('../escaped.e1', buf('x'))).rejects.toThrow('unsafe share path')
    await expect(s.read('../escaped.e1')).rejects.toThrow('unsafe share path')
    await expect(s.list('boards/..')).rejects.toThrow('unsafe share path')
    await expect(s.delete('..')).rejects.toThrow('unsafe share path')
  })
})
