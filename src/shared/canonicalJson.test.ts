import { describe, expect, it } from 'vitest'
import { canonicalJson } from './canonicalJson'

describe('canonicalJson', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  it('omits undefined-valued keys', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('keeps arrays in order and maps undefined elements to null', () => {
    expect(canonicalJson([3, 1, undefined, 'x'])).toBe('[3,1,null,"x"]')
  })

  it('is stable regardless of insertion order', () => {
    const a = canonicalJson({ x: 1, y: [true, { m: 1, a: 2 }], z: 'é' })
    const b = canonicalJson({ z: 'é', y: [true, { a: 2, m: 1 }], x: 1 })
    expect(a).toBe(b)
  })

  it('escapes strings like JSON', () => {
    expect(canonicalJson({ s: 'a"b\n' })).toBe('{"s":"a\\"b\\n"}')
  })

  it('handles integers exactly', () => {
    expect(canonicalJson(1757265000123)).toBe('1757265000123')
  })

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson(Infinity)).toThrow()
    expect(() => canonicalJson(NaN)).toThrow()
  })

  // Fixture vectors — any change to these breaks signature compatibility.
  it('matches frozen fixture vectors', () => {
    expect(
      canonicalJson({
        t: 'msg',
        conv: 'chan:a1b2c3d4',
        author: { device: 'ff00ff00', name: 'Gil' },
        senderSeq: 42,
        body: { kind: 'text', text: 'hello' },
      }),
    ).toBe(
      '{"author":{"device":"ff00ff00","name":"Gil"},"body":{"kind":"text","text":"hello"},"conv":"chan:a1b2c3d4","senderSeq":42,"t":"msg"}',
    )
  })
})
