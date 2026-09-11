import { describe, expect, it } from 'vitest'
import { CHANNEL_NAME_MAX, normalizeChannelName } from './channelName'

// Unicode code points spelled out via fromCharCode rather than pasted as
// literal glyphs, so this file stays plain ASCII (CLAUDE.md notes BSD grep
// silently misses multibyte files under the default locale).
const RLO = String.fromCharCode(0x202e) // RIGHT-TO-LEFT OVERRIDE
const LRM = String.fromCharCode(0x200e)
const RLM = String.fromCharCode(0x200f)
const BEL = String.fromCharCode(0x07)

describe('normalizeChannelName', () => {
  it('lower-cases, trims, and collapses internal whitespace into dashes', () => {
    expect(normalizeChannelName('  Release Planning  ')).toBe('release-planning')
    expect(normalizeChannelName('a\t\tb')).toBe('a-b')
  })

  it('strips one or more leading #s', () => {
    expect(normalizeChannelName('#general')).toBe('general')
    expect(normalizeChannelName('##general')).toBe('general')
  })

  it('strips control and bidi-override characters without treating them as separators', () => {
    expect(normalizeChannelName(`gen${RLO}eral`)).toBe('general')
    expect(normalizeChannelName(`gen${BEL}eral`)).toBe('general')
    expect(normalizeChannelName(`${LRM}hello${RLM}`)).toBe('hello')
  })

  it('caps at 40 characters', () => {
    expect(normalizeChannelName('x'.repeat(80))).toHaveLength(CHANNEL_NAME_MAX)
  })

  it('returns empty for whitespace-only or bare hashes', () => {
    expect(normalizeChannelName('   ')).toBe('')
    expect(normalizeChannelName('#')).toBe('')
  })
})
