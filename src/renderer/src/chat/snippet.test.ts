import { describe, expect, it } from 'vitest'
import type { MessageView } from '@shared/merge'
import { diagramFallbackText } from '@shared/diagram'
import { pollFallbackText } from '@shared/poll'
import { copyTextOf, snippetOf } from './util'

// The one-line preview used by reply quotes and the composer's reply bar. The
// diagram case is the interesting one: `body.text` there is the sentence
// written for 1.1 clients, so quoting it verbatim told a 1.2 user to go and
// update the app they are running.

const view = (over: Partial<MessageView> & { body: MessageView['body'] }): MessageView =>
  ({
    id: '1',
    conv: 'chan:x',
    author: { device: 'd', name: 'Ana' },
    ts: 0,
    attachments: [],
    reactions: {},
    ...over,
  }) as MessageView

describe('snippetOf', () => {
  it('names a diagram instead of repeating the 1.1 fallback sentence', () => {
    const m = view({ body: { kind: 'diagram', text: diagramFallbackText('Sprint plan') } })
    expect(snippetOf(m)).toBe('📐 Sprint plan')
    expect(snippetOf(m)).not.toMatch(/update Chat/)
  })

  it('names a diagram whose body text was never the fallback line', () => {
    expect(snippetOf(view({ body: { kind: 'diagram', text: 'Sprint plan' } }))).toBe('📐 Sprint plan')
  })

  it('names a poll by its question, not the pre-1.3 fallback sentence (1.3)', () => {
    const poll = {
      question: 'Ship on Friday?',
      options: [
        { id: 'yes', text: 'Yes' },
        { id: 'no', text: 'No' },
      ],
      multi: false,
      anonymous: false,
    }
    const m = view({ body: { kind: 'poll', text: pollFallbackText(poll.question), poll } })
    expect(snippetOf(m)).toBe('📊 Ship on Friday?')
    expect(snippetOf(m)).not.toMatch(/update Chat/)
    // A poll whose body never carried the PollBody (truncated, or hand-made)
    // still reads as its question rather than the fallback line.
    expect(snippetOf(view({ body: { kind: 'poll', text: pollFallbackText('Lunch?') } }))).toBe('📊 Lunch?')
  })

  it('still handles the other body kinds', () => {
    expect(snippetOf(view({ body: { kind: 'gif', text: '' } }))).toBe('GIF')
    expect(snippetOf(view({ body: { kind: 'code', text: 'const a = 1\nconst b = 2' } }))).toBe('const a = 1')
    expect(snippetOf(view({ body: { kind: 'text', text: '  hello   there ' } }))).toBe('hello there')
    expect(snippetOf(view({ deleted: true, body: { kind: 'text', text: 'x' } }))).toBe('message deleted')
  })

  it('falls back to attachment names for a body with no text', () => {
    const one = view({
      body: { kind: 'text', text: '' },
      attachments: [{ name: 'a.png' }] as MessageView['attachments'],
    })
    expect(snippetOf(one)).toBe('a.png')
    const two = view({
      body: { kind: 'text', text: '' },
      attachments: [{ name: 'a.png' }, { name: 'b.png' }] as MessageView['attachments'],
    })
    expect(snippetOf(two)).toBe('2 files')
  })
})

describe('copyTextOf', () => {
  // The row's Copy text used to hand over `body.text` whatever the body was,
  // which for a poll or a diagram is the sentence written for clients too old
  // to render it — so copying a poll pasted "update Chat to vote".
  it('copies the question of a poll and the name of a diagram, not the update notice', () => {
    const poll = {
      question: 'Ship on Friday?',
      options: [
        { id: 'yes', text: 'Yes' },
        { id: 'no', text: 'No' },
      ],
      multi: false,
      anonymous: false,
    }
    expect(copyTextOf(view({ body: { kind: 'poll', text: pollFallbackText(poll.question), poll } }))).toBe(
      '\u{1F4CA} Ship on Friday?',
    )
    expect(copyTextOf(view({ body: { kind: 'diagram', text: diagramFallbackText('Sprint plan') } }))).toBe(
      '\u{1F4D0} Sprint plan',
    )
  })

  it('copies everything else byte for byte — newlines and indentation included', () => {
    const code = 'function f() {\n  return 1\n}'
    expect(copyTextOf(view({ body: { kind: 'code', text: code } }))).toBe(code)
    expect(copyTextOf(view({ body: { kind: 'text', text: '  hello   there ' } }))).toBe('  hello   there ')
  })
})
