import { describe, expect, it } from 'vitest'
import type { EventPayload, MsgBody, PollBody, VerifiedEvent } from './types'
import { materialize } from './merge'
import { pollFallbackText } from './poll'

// Poll votes through the reader-side merge (1.3). A `vot` event is not a
// message and not a sys row: the only thing it can ever move is the vote map on
// the message it targets. That is what makes "votes never notify and never
// count as unread" true by construction rather than by a rule somewhere —
// nothing that counts messages can see a vote at all.

let n = 0
function ev(type: VerifiedEvent['type'], payload: EventPayload, author = 'dev1', at?: string): VerifiedEvent {
  const stem = at ?? `${String(1_700_000_000_000 + n).padStart(13, '0')}-${String(n).padStart(4, '0')}-${author.slice(0, 8)}`
  n++
  return { id: stem, type, payload, author, verified: true, receivedAt: 0 }
}

const poll: PollBody = {
  question: 'Ship on Friday?',
  options: [
    { id: 'yes', text: 'Yes' },
    { id: 'no', text: 'No' },
    { id: 'abstain', text: 'Abstain' },
  ],
  multi: false,
  anonymous: false,
  decision: true,
}

const pollBody: MsgBody = { kind: 'poll', text: pollFallbackText(poll.question), poll }

function pollMessage(author = 'alice'): VerifiedEvent {
  return ev(
    'msg',
    {
      t: 'msg',
      conv: 'chan:x',
      author: { device: author, name: 'Alice' },
      senderSeq: 1,
      sentWall: 0,
      body: pollBody,
    },
    author,
  )
}

const vote = (target: string, choice: string[], device: string, at?: string): VerifiedEvent =>
  ev('vot', { t: 'vot', conv: 'chan:x', target, choice }, device, at)

/** A stem with an exact HLC ms — what `closedAt` is compared against. */
const stemAt = (hlcMs: number, seq: number, device: string): string =>
  `${String(hlcMs).padStart(13, '0')}-${String(seq).padStart(4, '0')}-${device.padEnd(8, '0').slice(0, 8)}`

const closingEdit = (target: string, closedAt: number, at?: string): VerifiedEvent =>
  ev('edt', { t: 'edt', conv: 'chan:x', target, body: { ...pollBody, poll: { ...poll, closedAt } } }, 'alice', at)

describe('poll votes', () => {
  it('keeps the latest vote per device, whatever order the events arrive in', () => {
    const p = pollMessage()
    const first = vote(p.id, ['yes'], 'bob')
    const second = vote(p.id, ['no'], 'bob')
    const carol = vote(p.id, ['abstain'], 'carol')
    // Shuffled on purpose: materialize sorts by event id, so the answer must
    // not depend on which client read which file first.
    const log = materialize([second, p, carol, first])
    expect(log.messages[0].votes).toEqual({ bob: ['no'], carol: ['abstain'] })
  })

  it('takes a vote back when the choice is empty', () => {
    const p = pollMessage()
    const log = materialize([p, vote(p.id, ['yes'], 'bob'), vote(p.id, [], 'bob')])
    expect(log.messages[0].votes).toEqual({})
    expect('bob' in (log.messages[0].votes ?? {})).toBe(false)
  })

  it('records every option of a multi vote', () => {
    const multi: MsgBody = { ...pollBody, poll: { ...poll, multi: true } }
    const p = ev(
      'msg',
      { t: 'msg', conv: 'chan:x', author: { device: 'alice', name: 'Alice' }, senderSeq: 1, sentWall: 0, body: multi },
      'alice',
    )
    const log = materialize([p, vote(p.id, ['yes', 'abstain'], 'bob')])
    expect(log.messages[0].votes).toEqual({ bob: ['yes', 'abstain'] })
  })

  it('survives the author’s closing edit — closedAt lands, the votes stay', () => {
    const p = pollMessage()
    const closed: MsgBody = { ...pollBody, poll: { ...poll, closedAt: 1_700_000_500_000 } }
    const log = materialize([
      p,
      vote(p.id, ['yes'], 'bob'),
      ev('edt', { t: 'edt', conv: 'chan:x', target: p.id, body: closed }, 'alice'),
    ])
    expect(log.messages[0].body.poll?.closedAt).toBe(1_700_000_500_000)
    expect(log.messages[0].votes).toEqual({ bob: ['yes'] })
  })

  it('ignores votes on a deleted poll and on a message that is not one', () => {
    const p = pollMessage()
    const deleted = materialize([
      p,
      vote(p.id, ['yes'], 'bob'),
      ev('del', { t: 'del', conv: 'chan:x', target: p.id }, 'alice'),
    ])
    expect(deleted.messages[0].votes).toBeUndefined()

    const plain = ev(
      'msg',
      {
        t: 'msg',
        conv: 'chan:x',
        author: { device: 'alice', name: 'Alice' },
        senderSeq: 2,
        sentWall: 0,
        body: { kind: 'text', text: 'hello' },
      },
      'alice',
    )
    expect(materialize([plain, vote(plain.id, ['yes'], 'bob')]).messages[0].votes).toBeUndefined()
  })

  it('keeps the author’s closing edit when a stranger writes a later edt', () => {
    // The reviewer's scenario: [poll, the author's closing edt, a stranger's].
    // Edits are kept per (target, author) — a non-author's edt is not an edit
    // that loses on id order, it is no edit at all, and keeping one slot per
    // target let it shadow (and so undo) the close.
    const p = pollMessage()
    const log = materialize([
      p,
      closingEdit(p.id, 1_700_000_500_000),
      ev('edt', { t: 'edt', conv: 'chan:x', target: p.id, body: pollBody }, 'mallory'),
    ])
    expect(log.messages[0].body.poll?.closedAt).toBe(1_700_000_500_000)
    expect(log.messages[0].edited).toBe(true)
  })

  it('does not count a vote cast after the poll closed, and allows one in flight', () => {
    const p = pollMessage()
    const closedAt = 1_700_000_500_000
    const log = materialize([
      p,
      vote(p.id, ['yes'], 'bob', stemAt(closedAt - 100_000, 1, 'bob')),
      closingEdit(p.id, closedAt, stemAt(closedAt, 2, 'alice')),
      // A minute after the close: the result was announced, and this is not
      // part of it however many readers ingest the file.
      vote(p.id, ['no'], 'carol', stemAt(closedAt + 60_000, 3, 'carol')),
      // Inside the grace window: already published when Close was pressed.
      vote(p.id, ['yes'], 'dave', stemAt(closedAt + 4_000, 4, 'dave')),
    ])
    expect(log.messages[0].votes).toEqual({ bob: ['yes'], dave: ['yes'] })
  })

  it('a retraction after the close does not flip the decision', () => {
    const p = pollMessage()
    const closedAt = 1_700_000_500_000
    const before = (choice: string[], device: string, seq: number): VerifiedEvent =>
      vote(p.id, choice, device, stemAt(closedAt - 100_000 + seq, seq, device))
    const log = materialize([
      p,
      before(['yes'], 'bob', 1),
      before(['yes'], 'carol', 2),
      before(['no'], 'dave', 3),
      closingEdit(p.id, closedAt, stemAt(closedAt, 4, 'alice')),
      // Bob changes his mind about a decided poll: the vote that stood when it
      // closed is the one that counts, so 2–1 stays 2–1.
      vote(p.id, [], 'bob', stemAt(closedAt + 90_000, 5, 'bob')),
    ])
    expect(log.messages[0].votes).toEqual({ bob: ['yes'], carol: ['yes'], dave: ['no'] })
  })

  it('does not count one cast after the poll’s own deadline either', () => {
    // The other way a poll closes: the deadline it was published with, which
    // needs no event at all. `chat.vote` refuses on both, so a vote with a later
    // stem than either is a vote from a client that should not have written one.
    const closesAt = 1_700_000_500_000
    const p = ev(
      'msg',
      {
        t: 'msg',
        conv: 'chan:x',
        author: { device: 'alice', name: 'Alice' },
        senderSeq: 1,
        sentWall: 0,
        body: { ...pollBody, poll: { ...poll, closesAt } },
      },
      'alice',
      stemAt(closesAt - 3600_000, 1, 'alice'),
    )
    const log = materialize([
      p,
      vote(p.id, ['yes'], 'bob', stemAt(closesAt - 1000, 2, 'bob')),
      vote(p.id, ['no'], 'carol', stemAt(closesAt + 30_000, 3, 'carol')),
    ])
    expect(log.messages[0].votes).toEqual({ bob: ['yes'] })
  })

  it('never lands a vote whose stem is lower than this device’s previous one', () => {
    // Skewed HLC: LWW is by event id, exactly like a reaction, because the stem
    // is the only order every reader on the share can agree on. A device whose
    // clock went backwards writes an event that can never win — including its
    // own retraction, which is why `chat.vote` is the only writer of one.
    const p = pollMessage()
    const log = materialize([
      p,
      vote(p.id, ['yes'], 'bob', stemAt(1_700_000_400_000, 2, 'bob')),
      vote(p.id, [], 'bob', stemAt(1_700_000_300_000, 1, 'bob')),
    ])
    expect(log.messages[0].votes).toEqual({ bob: ['yes'] })
  })

  it('never becomes a message, a sys row, or a senderSeq gap', () => {
    const p = pollMessage()
    const withVotes = materialize([p, vote(p.id, ['yes'], 'bob'), vote(p.id, ['no'], 'carol')])
    const without = materialize([p])
    // The unread badge (store/index.ts) counts raw events of type 'msg', and
    // the notification path only ever fires on one. Both stay true only while
    // a `vot` adds nothing to either list here.
    expect(withVotes.messages).toHaveLength(1)
    expect(withVotes.messages).toHaveLength(without.messages.length)
    expect(withVotes.sys).toHaveLength(0)
    expect(withVotes.gaps).toEqual({})
  })
})

// Edits, generally (1.3 review fix). `edt` counts only from the message's own
// author, and the accumulator has to be keyed that way — not just checked that
// way at the end — or anyone on the share can shadow a real edit with their own.

describe('edits from someone who is not the author', () => {
  const plain = (): VerifiedEvent =>
    ev(
      'msg',
      {
        t: 'msg',
        conv: 'chan:x',
        author: { device: 'alice', name: 'Alice' },
        senderSeq: 1,
        sentWall: 0,
        body: { kind: 'text', text: 'hello' },
      },
      'alice',
    )

  const edit = (target: string, text: string, by: string): VerifiedEvent =>
    ev('edt', { t: 'edt', conv: 'chan:x', target, body: { kind: 'text', text } }, by)

  it('changes nothing at all', () => {
    const m = plain()
    const log = materialize([m, edit(m.id, 'hello, mallory', 'mallory')])
    expect(log.messages[0].body).toEqual({ kind: 'text', text: 'hello' })
    expect(log.messages[0].edited).toBe(false)
  })

  it('cannot erase the author’s own later edit by writing a later one', () => {
    const m = plain()
    const log = materialize([m, edit(m.id, 'hello, fixed', 'alice'), edit(m.id, 'hello, mallory', 'mallory')])
    expect(log.messages[0].body).toEqual({ kind: 'text', text: 'hello, fixed' })
    expect(log.messages[0].edited).toBe(true)
  })

  it('still lets the author’s own latest edit win over their earlier one', () => {
    const m = plain()
    const log = materialize([m, edit(m.id, 'first', 'alice'), edit(m.id, 'second', 'alice')])
    expect(log.messages[0].body).toEqual({ kind: 'text', text: 'second' })
  })
})
