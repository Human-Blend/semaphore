import { describe, expect, it } from 'vitest'
import type { MessageView } from '@shared/merge'
import { diagramFallbackText } from '@shared/diagram'
import { snippetOf } from './util'

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
