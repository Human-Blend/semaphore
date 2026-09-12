import { describe, expect, it } from 'vitest'
import type { PollBody } from './types'
import { POLL_LIMITS } from './constants'
import {
  calibrateClosesAt,
  checkChoice,
  isPollClosed,
  normalizePollBody,
  pollFallbackText,
  pollNotifySnippet,
  pollPreview,
  pollQuestionOf,
  validatePollDraft,
} from './poll'

// What main and the renderer have to agree on about a poll: the sentence a
// pre-1.3 client shows instead of the tile, the limits, the option ids, when a
// poll counts as closed, and which votes it can accept at all.

const poll = (over: Partial<PollBody> = {}): PollBody => ({
  question: 'Ship on Friday?',
  options: [
    { id: 'a', text: 'Yes' },
    { id: 'b', text: 'No' },
  ],
  multi: false,
  anonymous: false,
  ...over,
})

describe('the pre-1.3 fallback line', () => {
  it('round-trips the question and never leaks back into the UI verbatim', () => {
    const text = pollFallbackText('Ship on Friday?')
    expect(text).toBe('📊 Poll: Ship on Friday? — update Chat to vote')
    expect(pollQuestionOf(text)).toBe('Ship on Friday?')
    // The lesson from the 1.2 diagram tile: a 1.3 client must never quote the
    // sentence written for older ones back at its own user.
    expect(pollPreview({ text, poll: poll() })).toBe('📊 Ship on Friday?')
    expect(pollPreview({ text })).toBe('📊 Ship on Friday?')
    expect(pollPreview({ text })).not.toMatch(/update Chat/)
    expect(pollNotifySnippet({ text, poll: poll() })).toBe('started a poll: Ship on Friday?')
  })

  it('tolerates a body whose text was never the fallback sentence', () => {
    expect(pollQuestionOf('just a question')).toBe('just a question')
    expect(pollPreview({ text: '' })).toBe('📊 Untitled poll')
  })
})

describe('validatePollDraft', () => {
  it('accepts a good draft and names what is wrong with a bad one', () => {
    expect(validatePollDraft(poll())).toBe(null)
    expect(validatePollDraft(undefined)).toBe('poll-missing')
    expect(validatePollDraft(poll({ question: '   ' }))).toBe('poll-question-empty')
    expect(validatePollDraft(poll({ options: [{ id: 'a', text: 'Only one' }] }))).toBe('poll-too-few-options')
    expect(
      validatePollDraft(
        poll({
          options: Array.from({ length: POLL_LIMITS.maxOptions + 1 }, (_, i) => ({ id: `o${i}`, text: `x${i}` })),
        }),
      ),
    ).toBe('poll-too-many-options')
    expect(validatePollDraft(poll({ options: [{ id: 'a', text: 'Yes' }, { id: 'b', text: '  ' }] }))).toBe(
      'poll-option-empty',
    )
  })

  it('refuses two options that read the same, however they were typed', () => {
    // Different ids, one answer: the tally would split it across two rows and
    // the poll that was meant to decide something reports 3–3 with itself.
    // Compared the way the option text is cleaned — whitespace collapsed and
    // trimmed — and case-insensitively, because that is how a reader tells two
    // rows apart.
    expect(validatePollDraft(poll({ options: [{ id: 'a', text: 'Friday' }, { id: 'b', text: 'Friday' }] }))).toBe(
      'poll-duplicate-option',
    )
    expect(validatePollDraft(poll({ options: [{ id: 'a', text: 'Friday' }, { id: 'b', text: ' friday ' }] }))).toBe(
      'poll-duplicate-option',
    )
    expect(validatePollDraft(poll({ options: [{ id: 'a', text: 'ship  it' }, { id: 'b', text: 'Ship it' }] }))).toBe(
      'poll-duplicate-option',
    )
    // Options that merely start the same are fine, and so is the preset.
    expect(validatePollDraft(poll({ options: [{ id: 'a', text: 'Friday' }, { id: 'b', text: 'Friday week' }] }))).toBe(
      null,
    )
  })
})

describe('normalizePollBody', () => {
  it('fills in missing option ids and forces them unique', () => {
    const out = normalizePollBody(
      poll({
        options: [
          { id: '', text: 'Yes' },
          { id: 'dup', text: 'No' },
          { id: 'dup', text: 'Maybe' },
        ],
      }),
    )
    expect(out.options.map((o) => o.id)).toEqual(['o1', 'dup', 'o3'])
    expect(new Set(out.options.map((o) => o.id)).size).toBe(3)
  })

  it('keeps the quick-decision ids exactly as they are', () => {
    const out = normalizePollBody(
      poll({
        decision: true,
        options: [
          { id: 'yes', text: 'Yes' },
          { id: 'no', text: 'No' },
          { id: 'abstain', text: 'Abstain' },
        ],
      }),
    )
    expect(out.options.map((o) => o.id)).toEqual(['yes', 'no', 'abstain'])
    expect(out.decision).toBe(true)
  })

  it('trims to the limits and drops junk flags', () => {
    const out = normalizePollBody(
      poll({
        question: `  ${'q'.repeat(POLL_LIMITS.maxQuestionChars + 40)}  `,
        options: [
          { id: 'a', text: 'x'.repeat(POLL_LIMITS.maxOptionChars + 20) },
          { id: 'b', text: ' two   words ' },
        ],
        multi: 'yes' as unknown as boolean,
      }),
    )
    expect(out.question).toHaveLength(POLL_LIMITS.maxQuestionChars)
    expect(out.options[0].text).toHaveLength(POLL_LIMITS.maxOptionChars)
    expect(out.options[1].text).toBe('two words')
    expect(out.multi).toBe(false)
    expect(out.decision).toBeUndefined()
  })
})

describe('closing', () => {
  it('is closed by the author’s closedAt or by the deadline passing', () => {
    expect(isPollClosed(poll(), 1000)).toBe(false)
    expect(isPollClosed(poll({ closedAt: 1 }), 1000)).toBe(true)
    expect(isPollClosed(poll({ closesAt: 1000 }), 1000)).toBe(true)
    expect(isPollClosed(poll({ closesAt: 1001 }), 1000)).toBe(false)
  })

  it('restates the author’s interval on the share clock, within a sane window', () => {
    // Author's machine is an hour ahead of the share; the poll still closes in
    // the four hours they asked for, counted on the clock readers compare to.
    const wall = 5_000_000_000
    const share = wall - 3600_000
    expect(calibrateClosesAt(wall + 4 * 3600_000, wall, share)).toBe(share + 4 * 3600_000)
    expect(calibrateClosesAt(undefined, wall, share)).toBeUndefined()
    // Already in the past, or absurdly far out: clamped, never published dead.
    expect(calibrateClosesAt(wall - 99_000, wall, share)).toBe(share + 60_000)
    expect(calibrateClosesAt(wall + 400 * 86400_000, wall, share)).toBe(share + 30 * 86400_000)
  })
})

describe('checkChoice', () => {
  it('accepts a known option, a retraction, and refuses the rest', () => {
    expect(checkChoice(poll(), ['a'])).toEqual({ choice: ['a'] })
    expect(checkChoice(poll(), [])).toEqual({ choice: [] })
    expect(checkChoice(poll(), ['nope'])).toEqual({ error: 'unknown-option' })
    expect(checkChoice(poll(), ['a', 'b'])).toEqual({ error: 'single-choice' })
    expect(checkChoice(poll({ multi: true }), ['b', 'a'])).toEqual({ choice: ['a', 'b'] })
  })

  it('dedupes and orders by the poll, so the same answer is the same array', () => {
    expect(checkChoice(poll({ multi: true }), ['b', 'a', 'b'])).toEqual({ choice: ['a', 'b'] })
    expect(checkChoice(poll(), ['a', 'a'])).toEqual({ choice: ['a'] })
  })
})
