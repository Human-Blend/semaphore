import { describe, expect, it } from 'vitest'
import type { SysView } from '@shared/merge'
import type { ConvId, SysPayload } from '@shared/types'
import { sysLine } from './util'

// Every sys row the 1.2 client can render, pinned to its exact wording — and,
// more importantly, pinned to *having* wording at all. The shipped 1.1.2
// `sysLine()` has no default branch, so a kind it has never heard of falls off
// the end of the switch and returns `undefined`, which the timeline draws as a
// blank row. That is why the private-group notices moved to their own `grp`
// event type (a 1.1 client cannot even parse the filename, so it skips the file
// in silence) and why this build always returns a string.

const CONV: ConvId = 'chan:deadbeef'
const ALICE = 'a'.repeat(32)
const BOB = 'b'.repeat(32)

const NAMES: Record<string, string> = { [ALICE]: 'Alice', [BOB]: 'Bob' }
const nameOf = (d: string): string => NAMES[d] ?? 'Someone'

function row(kind: SysPayload['kind'], data: Record<string, unknown> = {}, author = ALICE): SysView {
  return { id: '1700000000001-0001-aaaaaaaa', conv: CONV, kind, data, authorDevice: author, hlcMs: 1700000000001 }
}

describe('sysLine', () => {
  it('renders one exact line per 1.2 sys kind', () => {
    expect(sysLine(row('channel-renamed', { name: 'planning' }), nameOf)).toBe('Alice renamed this channel to #planning')
    expect(sysLine(row('channel-deleted'), nameOf)).toBe('Alice deleted this channel')
    expect(sysLine(row('group-invite', { name: 'Ops crew' }), nameOf)).toBe('Alice added you to 🔒 Ops crew')
    expect(sysLine(row('group-rekey', { name: 'Ops crew' }), nameOf)).toBe('🔒 Ops crew keys were rotated')
    expect(sysLine(row('group-removed', { name: 'Ops crew' }), nameOf)).toBe('You were removed from 🔒 Ops crew')
    expect(sysLine(row('group-created', { members: [ALICE, BOB] }), nameOf)).toBe(
      'Alice created this private group with 2 members',
    )
    expect(sysLine(row('group-renamed', { name: 'Release crew' }), nameOf)).toBe('Alice renamed this group to Release crew')
    expect(sysLine(row('group-members-added', { members: [BOB] }), nameOf)).toBe('Alice added Bob')
    expect(sysLine(row('group-member-removed', { member: BOB }), nameOf)).toBe('Alice removed Bob')
    expect(sysLine(row('group-left', {}, BOB), nameOf)).toBe('Bob left the group')
    expect(sysLine(row('group-deleted'), nameOf)).toBe('Alice deleted this group')
  })

  it('falls back to a name-free line when the notice carries no name', () => {
    expect(sysLine(row('group-invite'), nameOf)).toBe('Alice added you to 🔒 a private group')
    expect(sysLine(row('group-removed', { groupId: '0a1b2c3d', epoch: 2 }), nameOf)).toBe(
      'You were removed from 🔒 a private group',
    )
  })

  it('never returns undefined for a kind from a newer build', () => {
    const future = row('something-from-1.3' as SysPayload['kind'])
    const line = sysLine(future, nameOf)
    expect(typeof line).toBe('string')
    expect(line).toBe('something changed in this conversation')
  })
})
