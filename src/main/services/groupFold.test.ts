import { describe, expect, it } from 'vitest'
import type { ConvId, SysPayload, VerifiedEvent } from '@shared/types'
import { foldGroupLog, normalizeGroupName } from './groups'

// A group's membership is whatever its log folds to, and the fold is where
// authorization lives: only the owner can add or remove someone or delete the
// group, any current member can rename. Everything before the snapshot that
// came with our own invite is already reflected in it and is skipped — that is
// what stops a member invited after a rotation from "re-adding" someone the
// owner removed in a record they can never read.

const CONV: ConvId = 'grp:0a1b2c3d'
const OWNER = 'a'.repeat(32)
const MEM = 'b'.repeat(32)
const OUTSIDER = 'c'.repeat(32)

function sys(id: string, kind: SysPayload['kind'], data: Record<string, unknown>, author: string): VerifiedEvent {
  return { id, type: 'sys', payload: { t: 'sys', conv: CONV, kind, data }, author, verified: true, receivedAt: 0 }
}

const base = { owner: OWNER, name: 'Ops', members: [OWNER, MEM], stem: '' }

describe('group name normalization', () => {
  it('trims, collapses whitespace and caps the length', () => {
    expect(normalizeGroupName('  Release   crew ')).toBe('Release crew')
    expect(normalizeGroupName('   ')).toBe('')
    expect(normalizeGroupName('n'.repeat(60))).toHaveLength(40)
  })
})

describe('folding a group log', () => {
  it('applies a rename from a current member', () => {
    const out = foldGroupLog(base, [sys('1700000000001-0001-bbbbbbbb', 'group-renamed', { name: 'Release crew' }, MEM)])
    expect(out.name).toBe('Release crew')
    expect(out.members.sort()).toEqual([OWNER, MEM].sort())
  })

  it('applies an add only from the owner', () => {
    // Membership is owner-managed end to end (1.2 review): a newcomer only ever
    // adopts an invite signed by the owner, so an add by a member could not
    // hand over a key — it could only pad the list with people who hold none.
    const byMember = foldGroupLog(base, [
      sys('1700000000002-0001-bbbbbbbb', 'group-members-added', { members: [OUTSIDER] }, MEM),
    ])
    expect(byMember.members).not.toContain(OUTSIDER)

    const byOwner = foldGroupLog(base, [
      sys('1700000000002-0001-aaaaaaaa', 'group-members-added', { members: [OUTSIDER] }, OWNER),
    ])
    expect(byOwner.members.sort()).toEqual([OWNER, MEM, OUTSIDER].sort())
  })

  it('ignores a rename and an add from someone who is not a member at all', () => {
    const out = foldGroupLog(base, [
      sys('1700000000001-0001-cccccccc', 'group-renamed', { name: 'hijacked' }, OUTSIDER),
      sys('1700000000002-0001-cccccccc', 'group-members-added', { members: [OUTSIDER] }, OUTSIDER),
    ])
    expect(out.name).toBe('Ops')
    expect(out.members).not.toContain(OUTSIDER)
  })

  it('lets only the owner remove a member, and records the new epoch', () => {
    const byMember = foldGroupLog(base, [
      sys('1700000000001-0001-bbbbbbbb', 'group-member-removed', { member: OWNER, epoch: 2 }, MEM),
    ])
    expect(byMember.members).toContain(OWNER)
    expect(byMember.epoch).toBe(1)

    const byOwner = foldGroupLog(base, [
      sys('1700000000001-0001-aaaaaaaa', 'group-member-removed', { member: MEM, epoch: 2 }, OWNER),
    ])
    expect(byOwner.members).toEqual([OWNER])
    expect(byOwner.epoch).toBe(2)
  })

  it('records where each rotation happened, so stale-key writes can be spotted', () => {
    const out = foldGroupLog(base, [
      sys('1700000000005-0001-aaaaaaaa', 'group-member-removed', { member: MEM, epoch: 2 }, OWNER),
      sys('1700000000009-0001-aaaaaaaa', 'group-member-removed', { member: OUTSIDER, epoch: 3 }, OWNER),
      // An unauthorized "rotation" from a member leaves no mark at all.
      sys('1700000000011-0001-bbbbbbbb', 'group-member-removed', { member: OWNER, epoch: 4 }, MEM),
    ])
    expect(out.rotations).toEqual({ '2': '1700000000005-0001-aaaaaaaa', '3': '1700000000009-0001-aaaaaaaa' })
    expect(out.epoch).toBe(3)
  })

  it('never removes the owner, even from an owner-signed event', () => {
    const out = foldGroupLog(base, [
      sys('1700000000001-0001-aaaaaaaa', 'group-member-removed', { member: OWNER, epoch: 2 }, OWNER),
    ])
    expect(out.members).toContain(OWNER)
  })

  it('drops the author of a group-left', () => {
    const out = foldGroupLog(base, [sys('1700000000001-0001-bbbbbbbb', 'group-left', {}, MEM)])
    expect(out.members).toEqual([OWNER])
  })

  it('ignores a group-deleted from a non-owner and honours the owner’s', () => {
    expect(foldGroupLog(base, [sys('1700000000001-0001-bbbbbbbb', 'group-deleted', {}, MEM)]).deletedAt).toBeUndefined()
    expect(foldGroupLog(base, [sys('1700000000009-0001-aaaaaaaa', 'group-deleted', {}, OWNER)]).deletedAt).toBe(
      1700000000009,
    )
  })

  it('re-adds nobody from events older than the invite snapshot we hold', () => {
    // Invited at a later point: our snapshot already knows OUTSIDER is out, and
    // the removal that took them out is under an epoch key we were never given.
    const later = { owner: OWNER, name: 'Ops', members: [OWNER, MEM], stem: '1700000000500-0000-00000000' }
    const out = foldGroupLog(later, [
      sys('1700000000100-0001-aaaaaaaa', 'group-members-added', { members: [OUTSIDER] }, OWNER),
      sys('1700000000600-0001-aaaaaaaa', 'group-renamed', { name: 'Ops 2' }, OWNER),
    ])
    expect(out.members).not.toContain(OUTSIDER)
    expect(out.name).toBe('Ops 2') // events after the snapshot still count
  })

  it('is order-independent: the same set folds the same either way', () => {
    const events = [
      sys('1700000000001-0001-aaaaaaaa', 'group-members-added', { members: [OUTSIDER] }, OWNER),
      sys('1700000000002-0001-aaaaaaaa', 'group-member-removed', { member: OUTSIDER, epoch: 2 }, OWNER),
      sys('1700000000003-0001-bbbbbbbb', 'group-renamed', { name: 'Final' }, MEM),
    ]
    const forward = foldGroupLog(base, events)
    const backward = foldGroupLog(base, [...events].reverse())
    expect(backward).toEqual(forward)
    expect(forward.members.sort()).toEqual([OWNER, MEM].sort())
    expect(forward.epoch).toBe(2)
  })

  it('ignores unverified events entirely', () => {
    const forged = { ...sys('1700000000009-0001-aaaaaaaa', 'group-deleted', {}, OWNER), verified: false }
    expect(foldGroupLog(base, [forged]).deletedAt).toBeUndefined()
  })
})
