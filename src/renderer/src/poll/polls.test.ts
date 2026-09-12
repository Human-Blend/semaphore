import { describe, expect, it } from 'vitest'
import type { PollBody } from '@shared/types'
import { DECISION_OPTIONS } from '@shared/poll'
import { closesInLabel, countdownTickMs, decisionOutcome, nextChoice, tallyPoll, voterLine } from './polls'

// The arithmetic behind a poll tile. The two things worth pinning hardest: a
// percentage is a share of *voters* (with `multi` one person picks several
// options, and a share of "votes cast" would understate every one of them), and
// a quick decision ignores abstentions but calls a tie no decision at all.

const poll = (over: Partial<PollBody> = {}): PollBody => ({
  question: 'Ship on Friday?',
  options: [
    { id: 'a', text: 'Yes, ship it' },
    { id: 'b', text: 'Wait for Monday' },
    { id: 'c', text: "Don't mind" },
  ],
  multi: false,
  anonymous: false,
  ...over,
})

const decision = (over: Partial<PollBody> = {}): PollBody =>
  poll({ options: DECISION_OPTIONS.map((o) => ({ ...o })), decision: true, ...over })

const ctx = { now: 1_000_000, me: 'me' }

describe('tallyPoll', () => {
  it('counts voters, not votes, and marks my own picks', () => {
    const p = poll({ multi: true })
    const r = tallyPoll(p, { me: ['a', 'b'], dev2: ['a'], dev3: ['c'] }, ctx)
    expect(r.voters).toBe(3)
    expect(r.options.map((o) => o.count)).toEqual([2, 1, 1])
    // Two of three people picked "a" — 67%, not 50% of the four picks cast.
    expect(r.options[0].percent).toBe(67)
    expect(r.options.filter((o) => o.mine).map((o) => o.id)).toEqual(['a', 'b'])
    expect(r.myChoice).toEqual(['a', 'b'])
    expect(r.options[0].leading).toBe(true)
    expect(r.options[1].leading).toBe(false)
  })

  it('is empty and flat with no votes at all', () => {
    const r = tallyPoll(poll(), {}, ctx)
    expect(r.voters).toBe(0)
    expect(r.options.every((o) => o.count === 0 && o.percent === 0 && !o.leading)).toBe(true)
    expect(voterLine(r)).toBe('No votes yet')
  })

  it('ignores option ids it has never heard of, but keeps the voter', () => {
    const r = tallyPoll(poll(), { dev2: ['a', 'gone'], dev3: ['gone'] }, ctx)
    expect(r.options[0].count).toBe(1)
    // dev3 picked nothing this poll body knows about: no count anywhere, and
    // not counted as a voter either.
    expect(r.voters).toBe(1)
  })

  it('lists voters in the same order on every client', () => {
    const one = tallyPoll(poll(), { zed: ['a'], ana: ['a'], mid: ['a'] }, ctx)
    const two = tallyPoll(poll(), { mid: ['a'], zed: ['a'], ana: ['a'] }, ctx)
    expect(one.options[0].voters).toEqual(['ana', 'mid', 'zed'])
    expect(two.options[0].voters).toEqual(one.options[0].voters)
  })

  it('reads closed from closedAt or a passed deadline', () => {
    expect(tallyPoll(poll(), {}, ctx).closed).toBe(false)
    expect(tallyPoll(poll({ closedAt: 5 }), {}, ctx).closed).toBe(true)
    expect(tallyPoll(poll({ closesAt: ctx.now - 1 }), {}, ctx).closed).toBe(true)
    expect(tallyPoll(poll({ closesAt: ctx.now + 1 }), {}, ctx).closed).toBe(false)
    expect(voterLine(tallyPoll(poll({ closedAt: 5 }), { a: ['a'] }, ctx))).toBe('1 vote · closed')
  })
})

describe('decisionOutcome', () => {
  const outcome = (votes: Record<string, string[]>, p = decision()) =>
    decisionOutcome(p, tallyPoll(p, votes, ctx))

  it('is a majority of yes against no, with abstentions left out', () => {
    const r = outcome({ a: ['yes'], b: ['yes'], c: ['yes'], d: ['yes'], e: ['no'], f: ['abstain'], g: ['abstain'] })
    expect(r?.decided).toBe('yes')
    expect(r?.label).toBe('Decided: Yes (4–1)')
  })

  it('names the winner first when it is No', () => {
    expect(outcome({ a: ['no'], b: ['no'], c: ['yes'] })?.label).toBe('Decided: No (2–1)')
  })

  it('calls a tie — and an empty poll — no decision', () => {
    expect(outcome({ a: ['yes'], b: ['no'] })?.decided).toBe(null)
    expect(outcome({ a: ['yes'], b: ['no'] })?.label).toBe('No decision')
    expect(outcome({})?.label).toBe('No decision')
    expect(outcome({ a: ['abstain'], b: ['abstain'] })?.label).toBe('No decision')
  })

  it('falls back to the first two options when the ids are not the preset', () => {
    const p = poll({ decision: true })
    expect(outcome({ a: ['a'], b: ['a'], c: ['b'] }, p)?.label).toBe('Decided: Yes (2–1)')
  })

  it('follows the votes that are still standing when one is retracted', () => {
    // `merge.ts` leaves no entry for a retraction, but a caller holding an empty
    // array must get the same answer: [] is not a voter, and a decision is only
    // ever counted from what still stands. Taking the third Yes back here turns
    // a 2–1 Yes into a tie, which is "No decision" and not a stale "Decided".
    expect(outcome({ a: ['yes'], b: ['no'], c: ['yes'] })?.label).toBe('Decided: Yes (2–1)')
    expect(outcome({ a: ['yes'], b: ['no'], c: [] })?.label).toBe('No decision')
    expect(outcome({ a: ['yes'], b: ['no'] })?.label).toBe('No decision')
    // And the last Yes leaving a one-sided poll empties it entirely.
    const gone = outcome({ a: [] })
    expect(gone?.decided).toBe(null)
    expect(gone?.yes).toBe(0)
  })

  it('is nothing at all for an ordinary poll', () => {
    const p = poll()
    expect(decisionOutcome(p, tallyPoll(p, { a: ['a'] }, ctx))).toBe(null)
  })
})

describe('nextChoice', () => {
  it('replaces the pick on a single-choice poll, and a second click retracts', () => {
    const p = poll()
    expect(nextChoice(p, [], 'a')).toEqual(['a'])
    expect(nextChoice(p, ['a'], 'b')).toEqual(['b'])
    expect(nextChoice(p, ['a'], 'a')).toEqual([])
  })

  it('toggles on a multi poll and keeps the poll’s own option order', () => {
    const p = poll({ multi: true })
    expect(nextChoice(p, ['c'], 'a')).toEqual(['a', 'c'])
    expect(nextChoice(p, ['a', 'c'], 'c')).toEqual(['a'])
  })

  it('ignores an option the poll does not have', () => {
    expect(nextChoice(poll(), ['a'], 'nope')).toEqual(['a'])
  })
})

describe('countdown', () => {
  it('formats what is left, and stops once it is up', () => {
    const now = 1_000_000
    expect(closesInLabel(poll({ closesAt: now + 50 * 60_000 }), now)).toBe('closes in 50 m')
    expect(closesInLabel(poll({ closesAt: now + 3 * 3600_000 + 12 * 60_000 }), now)).toBe('closes in 3 h 12 m')
    expect(closesInLabel(poll({ closesAt: now + 2 * 86400_000 + 3600_000 }), now)).toBe('closes in 2 d 1 h')
    expect(closesInLabel(poll({ closesAt: now + 45_000 }), now)).toBe('closes in 45 s')
    expect(closesInLabel(poll({ closesAt: now - 1 }), now)).toBe(null)
    expect(closesInLabel(poll(), now)).toBe(null)
    // A poll the author closed by hand counts down no further.
    expect(closesInLabel(poll({ closesAt: now + 60_000, closedAt: now }), now)).toBe(null)
  })

  it('ticks by the second only in the last minute, and not at all when there is nothing to show', () => {
    const now = 1_000_000
    expect(countdownTickMs(poll({ closesAt: now + 30_000 }), now)).toBe(1000)
    expect(countdownTickMs(poll({ closesAt: now + 3600_000 }), now)).toBe(30_000)
    expect(countdownTickMs(poll({ closesAt: now - 1 }), now)).toBe(0)
    expect(countdownTickMs(poll(), now)).toBe(0)
  })
})
