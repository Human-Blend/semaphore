// Canonical JSON for Ed25519 signing: UTF-8, object keys sorted lexicographically
// at every depth, no insignificant whitespace, no floats with exponent surprises
// (timestamps are integers), undefined-valued keys omitted, strings as-is
// (already NFC from the composer). Deterministic across platforms — unit-tested
// against fixture vectors.

export function canonicalJson(value: unknown): string {
  return serialize(value)
}

function serialize(v: unknown): string {
  if (v === null) return 'null'
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false'
    case 'number': {
      if (!Number.isFinite(v)) throw new Error('canonicalJson: non-finite number')
      if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) return String(v)
      // Floats are allowed but discouraged; JSON.stringify is deterministic per
      // IEEE-754 shortest round-trip, which V8 implements consistently.
      return JSON.stringify(v)
    }
    case 'string':
      return JSON.stringify(v)
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map((x) => serialize(x === undefined ? null : x)).join(',') + ']'
      const o = v as Record<string, unknown>
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + serialize(o[k])).join(',') + '}'
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof v}`)
  }
}
