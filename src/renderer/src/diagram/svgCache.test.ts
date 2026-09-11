import { describe, expect, it } from 'vitest'
import { SvgCache } from './svgCache'

const markup = (n: number): string => 'x'.repeat(n)

describe('SvgCache', () => {
  it('returns what it was given', () => {
    const c = new SvgCache(1000, 10)
    c.set('a', markup(10))
    expect(c.get('a')).toBe(markup(10))
    expect(c.get('missing')).toBeUndefined()
  })

  it('evicts by total size, not by entry count', () => {
    const c = new SvgCache(100, 100)
    c.set('a', markup(60))
    c.set('b', markup(60))
    expect(c.get('a')).toBeUndefined() // pushed out by bytes, with 98 slots free
    expect(c.get('b')).toBe(markup(60))
    expect(c.bytes).toBe(60)
  })

  it('evicts least-recently-USED, not least-recently-inserted', () => {
    const c = new SvgCache(100, 100)
    c.set('a', markup(40))
    c.set('b', markup(40))
    c.get('a') // 'a' is the one being looked at
    c.set('c', markup(40))
    expect(c.get('b')).toBeUndefined()
    expect(c.get('a')).toBe(markup(40))
    expect(c.get('c')).toBe(markup(40))
  })

  it('still honours the count bound', () => {
    const c = new SvgCache(1_000_000, 2)
    c.set('a', markup(1))
    c.set('b', markup(1))
    c.set('c', markup(1))
    expect(c.size).toBe(2)
    expect(c.get('a')).toBeUndefined()
  })

  it('keeps a single entry larger than the whole bound (it is about to render)', () => {
    const c = new SvgCache(100, 10)
    c.set('huge', markup(5000))
    expect(c.get('huge')).toBe(markup(5000))
    expect(c.size).toBe(1)
  })

  it('accounts for a replaced entry exactly once', () => {
    const c = new SvgCache(1000, 10)
    c.set('a', markup(100))
    c.set('a', markup(10))
    expect(c.size).toBe(1)
    expect(c.bytes).toBe(10)
  })

  it('never grows past the byte bound over a long scroll', () => {
    const c = new SvgCache(1000, 100)
    for (let i = 0; i < 200; i++) c.set(`k${i}`, markup(300))
    expect(c.bytes).toBeLessThanOrEqual(1000)
    expect(c.size).toBeLessThanOrEqual(4)
  })
})
