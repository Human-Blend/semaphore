import { describe, expect, it } from 'vitest'

// Every stylesheet this app injects lands in the same document, and
// `@keyframes` is a global name: the last definition in document order replaces
// every earlier one wholesale. ChatPane's CHAT_CSS is mounted *after*
// ChromeCss, so a name defined in both silently rewrites the chrome animation
// for the whole window — that is how PrAlert, the sidebar popover and
// BeamSurface came to animate 160px to the left, inheriting `.sem-jump`'s
// centring translate. Neither the type system nor the browser reports it, so
// the invariant is guarded here.

/** Both `sem-scale-in` definitions are the same animation, written twice. */
const KNOWN_EQUIVALENT = new Set(['sem-scale-in'])

const sources = import.meta.glob<string>('../**/*.{ts,tsx,css}', {
  query: '?raw',
  eager: true,
  import: 'default',
})

describe('injected CSS', () => {
  it('never defines the same @keyframes name in two files', () => {
    const owners = new Map<string, Set<string>>()
    for (const [file, text] of Object.entries(sources)) {
      if (file.endsWith('.test.ts')) continue
      for (const m of text.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)) {
        const set = owners.get(m[1]) ?? new Set<string>()
        set.add(file)
        owners.set(m[1], set)
      }
    }
    expect(owners.size).toBeGreaterThan(10) // the glob really did read the sources

    const clashes = [...owners]
      .filter(([name, files]) => files.size > 1 && !KNOWN_EQUIVALENT.has(name))
      .map(([name, files]) => `${name}: ${[...files].sort().join(', ')}`)
    expect(clashes).toEqual([])
  })
})
