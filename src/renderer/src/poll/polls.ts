import type { PollBody } from '@shared/types'
import { isPollClosed } from '@shared/poll'

// Everything a poll tile has to work out before it can draw itself: the tally,
// the decision, what a click on an option should send, and the countdown line.
// Pure and DOM-free so it can be tested in node — the tile above it is then
// only layout.
//
// The one rule worth stating out loud: a poll's numbers are counted in
// *voters*, not votes. With `multi` on, one person can pick three options, and
// a percentage of "votes cast" would say 33% for something everybody chose.

export interface PollOptionResult {
  id: string
  text: string
  count: number
  /** Share of the people who voted, 0–100. With `multi` these can sum past 100. */
  percent: number
  /** deviceIds, sorted so every client lists the same names in the same order. */
  voters: string[]
  /** This device picked it. */
  mine: boolean
  /** Tied for (or holding) the most votes, and someone actually voted. */
  leading: boolean
}

export interface PollResult {
  options: PollOptionResult[]
  /** Distinct devices with a vote standing. */
  voters: number
  closed: boolean
  myChoice: string[]
}

export function tallyPoll(
  poll: PollBody,
  votes: Record<string, string[]> | undefined,
  ctx: { now: number; me: string },
): PollResult {
  const byOption = new Map<string, string[]>()
  for (const o of poll.options) byOption.set(o.id, [])
  let voters = 0
  for (const [device, choice] of Object.entries(votes ?? {})) {
    if (!Array.isArray(choice) || choice.length === 0) continue
    let counted = false
    for (const id of choice) {
      const list = byOption.get(id)
      // An option id we don't know is a vote on a poll body we don't have (an
      // edit we haven't ingested yet). Drop the pick, not the voter.
      if (!list) continue
      list.push(device)
      counted = true
    }
    if (counted) voters++
  }

  const top = Math.max(0, ...[...byOption.values()].map((v) => v.length))
  const myChoice = [...(votes?.[ctx.me] ?? [])]
  const options = poll.options.map((o) => {
    const list = (byOption.get(o.id) ?? []).slice().sort()
    return {
      id: o.id,
      text: o.text,
      count: list.length,
      percent: voters === 0 ? 0 : Math.round((list.length / voters) * 100),
      voters: list,
      mine: myChoice.includes(o.id),
      leading: top > 0 && list.length === top,
    }
  })
  return { options, voters, closed: isPollClosed(poll, ctx.now), myChoice }
}

// ---------------------------------------------------------------------------
// Quick decisions

/**
 * Which options carry the decision. The preset writes the ids `yes`/`no`, but a
 * poll built by another client (or an older draft) may not have — in that case
 * the first two options are the question, in order, which is what the dialog
 * presents anyway.
 */
export function decisionIds(poll: PollBody): { yes: string; no: string } | null {
  if (!poll.decision || poll.options.length < 2) return null
  const has = (id: string): boolean => poll.options.some((o) => o.id === id)
  if (has('yes') && has('no')) return { yes: 'yes', no: 'no' }
  return { yes: poll.options[0].id, no: poll.options[1].id }
}

export interface DecisionOutcome {
  yes: number
  no: number
  /** null = no majority either way: a tie, or nobody voted. */
  decided: 'yes' | 'no' | null
  label: string
}

/**
 * Majority of Yes against No. Abstentions are deliberately not in the
 * arithmetic — abstaining is a way of saying "don't count me", and a poll where
 * four people say Yes, one says No and six abstain is still a Yes.
 */
export function decisionOutcome(poll: PollBody, result: PollResult): DecisionOutcome | null {
  const ids = decisionIds(poll)
  if (!ids) return null
  const count = (id: string): number => result.options.find((o) => o.id === id)?.count ?? 0
  const yes = count(ids.yes)
  const no = count(ids.no)
  const decided = yes > no ? 'yes' : no > yes ? 'no' : null
  const label =
    decided === 'yes' ? `Decided: Yes (${yes}–${no})` : decided === 'no' ? `Decided: No (${no}–${yes})` : 'No decision'
  return { yes, no, decided, label }
}

// ---------------------------------------------------------------------------
// Interaction + countdown

/**
 * What clicking one option should send. Single choice: picking it replaces
 * whatever was there, picking the one already chosen takes the vote back
 * (`[]`). Multiple choice: it toggles. Option order is the poll's, so two
 * clients that end up on the same answer send the identical array.
 */
export function nextChoice(poll: PollBody, current: string[], optionId: string): string[] {
  if (!poll.options.some((o) => o.id === optionId)) return current
  const picked = new Set(current.filter((id) => poll.options.some((o) => o.id === id)))
  if (poll.multi) {
    if (picked.has(optionId)) picked.delete(optionId)
    else picked.add(optionId)
  } else {
    const had = picked.has(optionId)
    picked.clear()
    if (!had) picked.add(optionId)
  }
  return poll.options.filter((o) => picked.has(o.id)).map((o) => o.id)
}

/** "closes in 3 h 12 m" while it is open on a deadline; null when there is nothing to count down. */
export function closesInLabel(poll: PollBody, now: number): string | null {
  if (!poll.closesAt || poll.closedAt) return null
  const left = poll.closesAt - now
  if (left <= 0) return null
  const s = Math.floor(left / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `closes in ${d} d ${h} h`
  if (h > 0) return `closes in ${h} h ${m} m`
  if (m > 0) return `closes in ${m} m`
  return `closes in ${Math.max(1, s)} s`
}

/** How often the tile has to re-render to keep `closesInLabel` honest. */
export function countdownTickMs(poll: PollBody, now: number): number {
  if (!poll.closesAt || poll.closedAt) return 0
  const left = poll.closesAt - now
  if (left <= 0) return 0
  return left < 60_000 ? 1000 : 30_000
}

/** The line under the options: who has voted, and what state the poll is in. */
export function voterLine(result: PollResult): string {
  const n = result.voters
  const who = n === 0 ? 'No votes yet' : `${n} ${n === 1 ? 'vote' : 'votes'}`
  return result.closed ? `${who} · closed` : who
}
