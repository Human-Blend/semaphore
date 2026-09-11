import { describe, expect, it } from 'vitest'
import hljs from 'highlight.js/lib/core'
import { CODE_LANGUAGES, HLJS_LANG_IDS, PLAIN_TEXT_ID } from './languages'
// Importing CodeBlock registers every grammar in HLJS_LANG_IDS (module-level
// side effect) against the same hljs core singleton this test imports above,
// and exports the pure explicit-vs-auto decision function (plan §D1).
import { resolveLanguage } from './CodeBlock'

describe('language table', () => {
  it('registers every hljs id the table lists', () => {
    for (const id of HLJS_LANG_IDS) {
      expect(hljs.getLanguage(id), `hljs.getLanguage('${id}') should be registered`).toBeTruthy()
    }
  })

  it('has 22 real hljs grammars (plan §0 row 6)', () => {
    expect(HLJS_LANG_IDS.length).toBe(22)
  })

  it('has unique labels', () => {
    const labels = CODE_LANGUAGES.map((l) => l.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('has unique ids (Auto-detect\'s null counted as its own slot)', () => {
    const ids = CODE_LANGUAGES.map((l) => l.id ?? '\0auto')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('the plain-text sentinel is not itself a registered hljs grammar', () => {
    expect(hljs.getLanguage(PLAIN_TEXT_ID)).toBeFalsy()
  })

  it('TypeScript is first (the composer default)', () => {
    expect(CODE_LANGUAGES[0]).toEqual({ id: 'typescript', label: 'TypeScript' })
  })

  it('Auto-detect is last and maps to null', () => {
    expect(CODE_LANGUAGES[CODE_LANGUAGES.length - 1]).toEqual({ id: null, label: 'Auto-detect' })
  })
})

describe('resolveLanguage — explicit beats auto-detect (plan §D1)', () => {
  // Reliably auto-detects as JSON with high relevance and a clear margin over
  // the runner-up, even across the full 22-language auto-detect pool — see
  // the "sanity check" test below. Used as "content that is NOT the
  // explicitly-chosen language" for the override tests.
  const JSON_SNIPPET = '{"name": "chat", "version": "1.2.0", "list": [1, 2, 3], "nested": {"a": true, "b": null}}'

  it('sanity check: auto-detects the fixture as json with confident relevance', () => {
    const r = resolveLanguage(null, JSON_SNIPPET)
    expect(r.mode).toBe('auto')
    expect(r.language).toBe('json')
  })

  it('an explicit, registered language always wins — no relevance gate applies', () => {
    // JSON content, but the user explicitly chose Python: explicit must win
    // outright, not fall back because the content doesn't "look like" it.
    const r = resolveLanguage('python', JSON_SNIPPET)
    expect(r.mode).toBe('explicit')
    expect(r.language).toBe('python')
  })

  it('normalizes a known alias before the registry lookup, still as explicit', () => {
    const r = resolveLanguage('py', JSON_SNIPPET)
    expect(r.mode).toBe('explicit')
    expect(r.language).toBe('python')
  })

  it('an unrecognized explicit language falls back to auto-detect under today\'s gate', () => {
    const r = resolveLanguage('cobol-9000', JSON_SNIPPET)
    expect(r.mode).toBe('auto')
    expect(r.language).toBe('json')
  })

  it('the plain-text sentinel never falls back to auto-detect', () => {
    const r = resolveLanguage(PLAIN_TEXT_ID, JSON_SNIPPET)
    expect(r.mode).toBe('plain')
    expect(r.language).toBeNull()
    expect(r.html).not.toContain('hljs-')
  })

  it('Auto-detect (null) with no confident guess renders unhighlighted', () => {
    const r = resolveLanguage(null, 'x')
    expect(r.mode).toBe('none')
    expect(r.language).toBeNull()
  })
})
