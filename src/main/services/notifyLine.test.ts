import { describe, expect, it } from 'vitest'
import { notifyLineFor } from './notifyLine'

// The whole wording matrix an OS notification can produce: three conversation
// kinds times previews on/off. A private group notifies like a DM (you were
// invited into it personally) but must never *read* like one, and with previews
// off nothing at all about the message may leave the app.

describe('notifyLineFor', () => {
  it('names the channel when previews are on', () => {
    expect(notifyLineFor({ kind: 'chan', who: 'Alice', convName: 'general', previews: true, snippet: 'hello team' })).toEqual(
      { title: 'Alice in #general', body: 'hello team' },
    )
  })

  it('is just the sender for a DM', () => {
    expect(notifyLineFor({ kind: 'dm', who: 'Alice', previews: true, snippet: 'secret plan' })).toEqual({
      title: 'Alice',
      body: 'secret plan',
    })
  })

  it('marks a private group with the lock and its name', () => {
    expect(
      notifyLineFor({ kind: 'grp', who: 'Alice', convName: 'Ops crew', previews: true, snippet: 'kickoff at 10' }),
    ).toEqual({ title: 'Alice in 🔒 Ops crew', body: 'kickoff at 10' })
  })

  it('falls back when the conversation has no name yet', () => {
    expect(notifyLineFor({ kind: 'chan', who: 'Alice', convName: null, previews: true, snippet: 'x' }).title).toBe(
      'Alice in #channel',
    )
    expect(notifyLineFor({ kind: 'grp', who: 'Alice', convName: '', previews: true, snippet: 'x' }).title).toBe(
      'Alice in 🔒 private group',
    )
  })

  it('leaks nothing with previews off — not the sender, not the room, not a word', () => {
    for (const kind of ['chan', 'dm', 'grp'] as const) {
      const line = notifyLineFor({ kind, who: 'Alice', convName: 'Ops crew', previews: false, snippet: 'kickoff at 10' })
      expect(line.title).toBe('Chat')
      expect(line.body).not.toContain('Alice')
      expect(line.body).not.toContain('Ops crew')
      expect(line.body).not.toContain('kickoff')
    }
    expect(notifyLineFor({ kind: 'dm', who: 'Alice', previews: false, snippet: 'x' }).body).toBe('New direct message')
    // A private group is not a direct message and does not claim to be one.
    expect(notifyLineFor({ kind: 'grp', who: 'Alice', previews: false, snippet: 'x' }).body).toBe('New message')
    expect(notifyLineFor({ kind: 'chan', who: 'Alice', previews: false, snippet: 'x' }).body).toBe('New message')
  })
})
