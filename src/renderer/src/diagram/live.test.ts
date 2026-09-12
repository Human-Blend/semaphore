import { describe, expect, it } from 'vitest'
import type { BoardFrame, ConvId, SysPayload, VerifiedEvent } from '@shared/types'
import type { SysView } from '@shared/merge'
import { BOARD } from '@shared/constants'
import {
  boardColor,
  boardJoinAction,
  digestFrames,
  endBoardIn,
  foldBoardEvents,
  keepPending,
  markSent,
  newFileTracker,
  pruneParticipants,
  sceneChanged,
  selectNewFiles,
  type LiveBoardMap,
  type ParticipantMap,
} from './live'
import { MAX_SCENE_ELEMENTS } from './sanitize'
import { sceneSignature } from './scene'

// The live-board decisions, without Excalidraw: what a delivery of frames
// turns into, who is still on the board, which files still have to travel, and
// whether a session is still joinable.

const CONV: ConvId = 'chan:deadbeef'
const ALICE = 'a'.repeat(32)
const BOB = 'b'.repeat(32)
const CAROL = 'c'.repeat(32)

const el = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  type: 'rectangle',
  version: 1,
  versionNonce: 1,
  ...over,
})

function frame(over: Partial<BoardFrame> = {}): BoardFrame {
  return {
    sessionId: 'sid',
    device: BOB,
    name: 'Bob',
    seq: 1,
    at: 1_700_000_000_000,
    elements: [el('r1')],
    ...over,
  }
}

const DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

describe('boardColor', () => {
  it('is stable for a device id and spreads over the palette', () => {
    expect(boardColor(ALICE)).toEqual(boardColor(ALICE))
    expect(boardColor(ALICE).background).toMatch(/^#[0-9a-f]{6}$/)
    // Real device ids are 32 hex characters, and a team's worth of them must
    // not all land on the same swatch — which is exactly what an unmixed FNV
    // hash did for ids made of one repeated digit.
    const ids = '0123456789abcdef'.split('').map((c) => c.repeat(32))
    const seen = new Set(ids.map((d) => boardColor(d).background))
    expect(seen.size).toBeGreaterThanOrEqual(4)
  })

  it('gives background and stroke, the shape Excalidraw wants', () => {
    const c = boardColor(BOB)
    expect(Object.keys(c).sort()).toEqual(['background', 'stroke'])
  })
})

describe('digestFrames', () => {
  const base = { selfDevice: ALICE, participants: {} as ParticipantMap, now: 1000 }

  it('drops our own frames and keeps only the newest frame per remote device', () => {
    const out = digestFrames(
      [
        frame({ device: ALICE, seq: 9, elements: [el('mine')] }),
        frame({ device: BOB, seq: 1, elements: [el('r1')] }),
        frame({ device: BOB, seq: 2, elements: [el('r1'), el('r2')] }),
        frame({ device: CAROL, name: 'Carol', seq: 4, elements: [el('c1')] }),
      ],
      base,
    )
    expect(out.batches.map((b) => b.device)).toEqual([BOB, CAROL])
    expect(out.batches[0].elements).toHaveLength(2)
    expect(Object.keys(out.participants).sort()).toEqual([BOB, CAROL].sort())
  })

  it('collects files from every frame in the delivery, not just the newest', () => {
    const out = digestFrames(
      [
        frame({ seq: 1, files: { f1: { id: 'f1', dataURL: DATA_URL } } }),
        frame({ seq: 2, files: { f2: { id: 'f2', dataURL: DATA_URL } } }),
      ],
      base,
    )
    expect(Object.keys(out.files).sort()).toEqual(['f1', 'f2'])
  })

  it('refuses a file that points anywhere but data:', () => {
    const out = digestFrames(
      [frame({ files: { evil: { id: 'evil', dataURL: 'https://tracker.example/x.png' } } })],
      base,
    )
    expect(out.files).toEqual({})
  })

  it('drops an over-sized frame without losing the rest of the delivery', () => {
    const huge = Array.from({ length: MAX_SCENE_ELEMENTS + 1 }, (_, i) => el(`h${i}`))
    const out = digestFrames([frame({ device: BOB, elements: huge }), frame({ device: CAROL, seq: 1 })], base)
    expect(out.batches.map((b) => b.device)).toEqual([CAROL])
    // …but the writer is still a participant: they are present, just unusable.
    expect(out.participants[BOB]).toBeTruthy()
  })

  it('skips junk elements and keeps the real ones', () => {
    const out = digestFrames([frame({ elements: [el('ok'), null, 42, { noId: true }] })], base)
    expect(out.batches[0].elements).toEqual([el('ok')])
  })

  it('passes scene-coordinate pointers through untouched, and refuses a broken one', () => {
    const out = digestFrames([frame({ pointer: { x: -1234.5, y: 987.25, tool: 'laser' } })], base)
    expect(out.participants[BOB].pointer).toEqual({ x: -1234.5, y: 987.25, tool: 'laser' })
    const bad = digestFrames([frame({ pointer: { x: NaN, y: 0, tool: 'pointer' } })], base)
    expect(bad.participants[BOB].pointer).toBeUndefined()
  })

  it('names an unnamed writer by their id prefix and colours them stably', () => {
    const out = digestFrames([frame({ name: '   ' })], base)
    expect(out.participants[BOB].name).toBe(BOB.slice(0, 8))
    expect(out.participants[BOB].color).toEqual(boardColor(BOB))
  })

  it('drops a participant who has gone quiet for longer than BOARD.staleMs', () => {
    const first = digestFrames([frame({ device: BOB })], { ...base, now: 0 })
    expect(first.participants[BOB]).toBeTruthy()
    const later = digestFrames([frame({ device: CAROL, name: 'Carol' })], {
      selfDevice: ALICE,
      participants: first.participants,
      now: BOARD.staleMs + 1,
    })
    expect(later.participants[BOB]).toBeUndefined()
    expect(later.participants[CAROL]).toBeTruthy()
  })
})

describe('pruneParticipants', () => {
  const map: ParticipantMap = {
    [BOB]: { device: BOB, name: 'Bob', color: boardColor(BOB), selectedIds: [], seenAt: 0 },
  }

  it('returns the same object when nobody is stale', () => {
    expect(pruneParticipants(map, BOARD.staleMs)).toBe(map)
  })

  it('returns a new, smaller map when someone is', () => {
    expect(pruneParticipants(map, BOARD.staleMs + 1)).toEqual({})
  })
})

// The echo guard, over real signatures rather than two hand-written strings
// (`sceneChanged('2:17', '3:99')` only ever restated `!==`). What it has to get
// right is the round trip: `useLiveBoard` stores the signature of the scene a
// reconcile left on the canvas, and the `onChange` Excalidraw fires for its own
// `updateScene` must then compare equal and write nothing — while a local edit
// in the same tick must still go out.
//
// TODO(1.3): the two refs that hold that state live in `useLiveBoard.ts` and are
// not reachable from node (no extraction into `live.ts` as of this review round),
// and the E2E drives `window.bridge.boards.write` directly — its closest step,
// "alice gets a board-frames push carrying bob's element", never enters the
// editor's `onChange`. So the wiring itself is covered by review and the packaged
// two-instance smoke; everything below it is covered here.
describe('the echo guard', () => {
  const canvas = (els: [id: string, version: number][]): { id: string; version: number; versionNonce: number }[] =>
    els.map(([id, version]) => ({ id, version, versionNonce: version * 7 }))

  it('writes nothing when the scene it sees is the one a remote frame just left', () => {
    const mine = canvas([['a', 1]])
    const afterRemote = canvas([
      ['a', 1],
      ['b', 2],
    ])
    // A peer's frame reconciled onto our canvas: the guard is re-primed with the
    // result, so Excalidraw's own `onChange` for that `updateScene` is silence.
    expect(sceneChanged(sceneSignature(mine), sceneSignature(afterRemote))).toBe(true)
    expect(sceneChanged(sceneSignature(afterRemote), sceneSignature(afterRemote))).toBe(false)
  })

  it('still writes when the local user changed something in the same tick', () => {
    const afterRemote = canvas([
      ['a', 1],
      ['b', 2],
    ])
    const alsoMine = canvas([
      ['a', 2],
      ['b', 2],
    ])
    expect(sceneChanged(sceneSignature(afterRemote), sceneSignature(alsoMine))).toBe(true)
  })

  it('sees a deletion, because the scene is counted with its tombstones', () => {
    // Why the hook reads `getSceneElementsIncludingDeleted` on both sides: an
    // element removed locally keeps its slot and bumps its version, and counting
    // only live elements would make "b deleted" look like a scene that never
    // moved once the lengths happened to match.
    const before = canvas([
      ['a', 1],
      ['b', 1],
    ])
    const deleted = [...canvas([['a', 1]]), { id: 'b', version: 2, versionNonce: 14, isDeleted: true }]
    expect(sceneChanged(sceneSignature(before), sceneSignature(deleted))).toBe(true)
  })
})

describe('selectNewFiles', () => {
  const files = { f1: { id: 'f1', dataURL: DATA_URL } }

  it('sends a file, keeps sending it through the coalescing window, then stops', () => {
    const t = newFileTracker()
    expect(selectNewFiles(t, files, 0)).toEqual(files)
    // Main keeps only the latest draft per window, so the file rides along
    // until the window it was first queued in has certainly been flushed.
    expect(selectNewFiles(t, files, BOARD.writeMinMs)).toEqual(files)
    expect(selectNewFiles(t, files, BOARD.writeMinMs * 2)).toBeUndefined()
  })

  it('returns undefined rather than an empty object when there is nothing new', () => {
    expect(selectNewFiles(newFileTracker(), {}, 0)).toBeUndefined()
  })

  it('never sends back a file that arrived from a peer', () => {
    const t = newFileTracker()
    markSent(t, ['f1'])
    expect(selectNewFiles(t, files, 0)).toBeUndefined()
  })

  it('picks up a file added later on its own', () => {
    const t = newFileTracker()
    selectNewFiles(t, files, 0)
    const both = selectNewFiles(t, { ...files, f2: { id: 'f2', dataURL: DATA_URL } }, BOARD.writeMinMs * 2)
    expect(Object.keys(both ?? {})).toEqual(['f2'])
  })
})

describe('keepPending', () => {
  const files = { f1: { id: 'f1', dataURL: DATA_URL } }

  it('offers a dropped file again, even after it counted as delivered', () => {
    const t = newFileTracker()
    // Sent, and old enough that the tracker considers it on the share…
    expect(selectNewFiles(t, files, 0)).toEqual(files)
    expect(selectNewFiles(t, files, BOARD.writeMinMs * 2)).toBeUndefined()
    // …except main had to drop it to fit the frame budget, and said so.
    keepPending(t, ['f1'], BOARD.writeMinMs * 2)
    expect(selectNewFiles(t, files, BOARD.writeMinMs * 2)).toEqual(files)
    // And it travels for a fresh coalescing window, not the original one.
    expect(selectNewFiles(t, files, BOARD.writeMinMs * 3)).toEqual(files)
    expect(selectNewFiles(t, files, BOARD.writeMinMs * 4)).toBeUndefined()
  })

  it('ignores junk in the dropped list', () => {
    const t = newFileTracker()
    expect(() => keepPending(t, ['', null as unknown as string], 0)).not.toThrow()
    expect(t.pending.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The session registry

function sysEvent(kind: 'board-live' | 'board-ended', data: Record<string, unknown>, author = ALICE): VerifiedEvent {
  const payload: SysPayload = { t: 'sys', conv: CONV, kind, data }
  return { id: `170000000000${data.n ?? 1}-0001-aaaaaaaa`, type: 'sys', payload, author, verified: true, receivedAt: 0 }
}

const LIVE = { sessionId: 'ses1', title: 'Sprint plan', host: ALICE, startedAt: 1_700_000_000_000, boardId: 'ev1' }

describe('foldBoardEvents', () => {
  it('indexes a board-live and keeps the same object when nothing changed', () => {
    const map = foldBoardEvents({}, [sysEvent('board-live', LIVE)])
    expect(map.ses1).toMatchObject({ conv: CONV, title: 'Sprint plan', host: ALICE, boardId: 'ev1', ended: false })
    expect(foldBoardEvents(map, [sysEvent('board-live', LIVE)])).toBe(map)
  })

  it('marks a session ended', () => {
    const map = foldBoardEvents(foldBoardEvents({}, [sysEvent('board-live', LIVE)]), [
      sysEvent('board-ended', { sessionId: 'ses1' }),
    ])
    expect(map.ses1.ended).toBe(true)
    expect(map.ses1.title).toBe('Sprint plan')
  })

  it('does not resurrect a session when the board-live push lands after the board-ended', () => {
    const map = foldBoardEvents({}, [sysEvent('board-ended', { sessionId: 'ses1' }), sysEvent('board-live', LIVE)])
    expect(map.ses1.ended).toBe(true)
    expect(map.ses1.title).toBe('Sprint plan')
  })

  it('ignores unverified events and anything without a session id', () => {
    const unverified = { ...sysEvent('board-live', LIVE), verified: false }
    expect(foldBoardEvents({}, [unverified])).toEqual({})
    expect(foldBoardEvents({}, [sysEvent('board-live', { title: 'no id' })])).toEqual({})
  })

  it('takes the host from the signer, not from the payload', () => {
    // `data.host` is written truthfully by every client we ship and is still a
    // field a member could put anyone's device id into — and it decides whose
    // `board-ended` is obeyed. Same call main made (contract-changes-1.3).
    const map = foldBoardEvents({}, [sysEvent('board-live', { ...LIVE, sessionId: 'ses2', host: CAROL }, BOB)])
    expect(map.ses2.host).toBe(BOB)
    // …including when the payload names nobody at all.
    expect(foldBoardEvents({}, [sysEvent('board-live', { sessionId: 'ses3' }, BOB)]).ses3.host).toBe(BOB)
  })

  it('ignores a board-ended from anyone but the host', () => {
    const live = foldBoardEvents({}, [sysEvent('board-live', LIVE)]) // hosted by ALICE
    const forged = foldBoardEvents(live, [sysEvent('board-ended', { sessionId: 'ses1' }, BOB)])
    expect(forged.ses1.ended).toBe(false)
    expect(forged).toBe(live) // nothing changed at all
    // The host's own still ends it.
    expect(foldBoardEvents(live, [sysEvent('board-ended', { sessionId: 'ses1' }, ALICE)]).ses1.ended).toBe(true)
  })
})

describe('endBoardIn', () => {
  it('marks a known session dead (a join that found no directory)', () => {
    const map = foldBoardEvents({}, [sysEvent('board-live', LIVE)])
    expect(endBoardIn(map, 'ses1').ses1.ended).toBe(true)
    const dead = endBoardIn(map, 'ses1')
    expect(endBoardIn(dead, 'ses1')).toBe(dead)
  })

  it('tombstones a session it has never seen', () => {
    expect(endBoardIn({}, 'ghost').ghost.ended).toBe(true)
  })
})

describe('boardJoinAction', () => {
  const row = (kind: SysPayload['kind'], data: Record<string, unknown>): SysView => ({
    id: '1700000000001-0001-aaaaaaaa',
    conv: CONV,
    kind,
    data,
    authorDevice: ALICE,
    hlcMs: 1_700_000_000_001,
  })
  const boards: LiveBoardMap = foldBoardEvents({}, [sysEvent('board-live', LIVE)])

  it('offers Join while the session is alive', () => {
    const action = boardJoinAction(row('board-live', { sessionId: 'ses1' }), boards)
    expect(action?.label).toBe('Join')
    expect(action?.entry.title).toBe('Sprint plan')
  })

  it('offers nothing once it ended, for an unknown session, or on another kind of row', () => {
    expect(boardJoinAction(row('board-live', { sessionId: 'ses1' }), endBoardIn(boards, 'ses1'))).toBeNull()
    expect(boardJoinAction(row('board-live', { sessionId: 'nope' }), boards)).toBeNull()
    expect(boardJoinAction(row('board-ended', { sessionId: 'ses1' }), boards)).toBeNull()
    expect(boardJoinAction(row('board-live', {}), boards)).toBeNull()
  })
})
