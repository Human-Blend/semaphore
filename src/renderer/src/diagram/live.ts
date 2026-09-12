// The renderer-free half of a live board (1.3).
//
// Everything here is a pure decision the live editor makes about frames that
// came off the share — which of them still matter, what may be handed to
// Excalidraw's reconciler, who is still holding a pointer, which binary files
// this device has already put on the wire — so it can be tested in node
// without loading the 1 MB editor chunk (vitest here is node-only).
//
// Nothing in this module imports Excalidraw. `useLiveBoard.ts` is where the
// reconciler, `updateScene` and `addFiles` live, behind the lazy boundary.

import type { BoardFrame, ConvId, SysPayload, VerifiedEvent } from '@shared/types'
import type { SysView } from '@shared/merge'
import { BOARD } from '@shared/constants'
import { MAX_SCENE_ELEMENTS, sanitizeSceneFiles } from './sanitize'

// ---------------------------------------------------------------------------
// Colour

/**
 * Eight cursor colours, stable per device for the life of the install.
 *
 * Excalidraw wants `{ background, stroke }` per collaborator (the dot and its
 * outline). They are picked from the id rather than from a join counter so the
 * same person is the same colour in every participant's window — a counter
 * would colour Ana blue on one client and green on another, since nobody sees
 * the joins in the same order.
 */
const BOARD_COLORS: readonly { background: string; stroke: string }[] = [
  { background: '#e03131', stroke: '#c92a2a' },
  { background: '#1971c2', stroke: '#1864ab' },
  { background: '#2f9e44', stroke: '#2b8a3e' },
  { background: '#f08c00', stroke: '#e67700' },
  { background: '#9c36b5', stroke: '#862e9c' },
  { background: '#0c8599', stroke: '#0b7285' },
  { background: '#d6336c', stroke: '#c2255c' },
  { background: '#5f3dc4', stroke: '#5235ab' },
]

/**
 * FNV-1a over the id, then an avalanche mix. The mix is not decoration: FNV's
 * low three bits barely move (the prime is 3 mod 8), so `hash % 8` over ids
 * that differ only in their characters' low bits — which is what a run of the
 * same hex digit is — handed every device the same colour.
 */
function hashOf(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d) >>> 0
  h ^= h >>> 15
  return h >>> 0
}

export function boardColor(deviceId: string): { background: string; stroke: string } {
  return BOARD_COLORS[hashOf(deviceId) % BOARD_COLORS.length]
}

// ---------------------------------------------------------------------------
// Participants

export interface LiveParticipant {
  device: string
  name: string
  color: { background: string; stroke: string }
  pointer?: { x: number; y: number; tool: 'pointer' | 'laser' }
  selectedIds: string[]
  /** Local clock when this device's last frame landed — the staleness clock. */
  seenAt: number
}

export type ParticipantMap = Record<string, LiveParticipant>

/**
 * Drop everyone whose last frame is older than `staleMs`.
 *
 * Measured against the *local* clock (when the frame was delivered), not the
 * frame's share-calibrated `at`: a peer whose clock runs a minute fast would
 * otherwise never go stale, and one running slow would vanish immediately.
 */
export function pruneParticipants(map: ParticipantMap, now: number, staleMs: number = BOARD.staleMs): ParticipantMap {
  let dropped = false
  const out: ParticipantMap = {}
  for (const [device, p] of Object.entries(map)) {
    if (now - p.seenAt > staleMs) dropped = true
    else out[device] = p
  }
  return dropped ? out : map
}

// ---------------------------------------------------------------------------
// Inbound frames

export interface FrameBatch {
  device: string
  name: string
  /** The writer's full element list, already capped and de-junked. */
  elements: unknown[]
}

export interface InboundFrames {
  /** One batch per remote device, newest frame only, ordered by device id. */
  batches: FrameBatch[]
  /** Every `data:` file carried by any frame in this delivery, keyed by id. */
  files: Record<string, unknown>
  participants: ParticipantMap
}

/**
 * Turn a `board-frames` delivery into reconcile input.
 *
 * Each frame carries its writer's *whole* element list (Excalidraw keeps
 * `isDeleted` tombstones, so a full list reconciles cleanly), which means only
 * the newest frame per device is worth reconciling — older ones in the same
 * delivery are strictly superseded. `files` are the exception: a binary file is
 * put on the wire once, by whichever frame first carried it, so they are
 * collected from *every* frame in the delivery.
 *
 * Own frames are skipped: main echoes nothing back, but a forged `device` on
 * someone else's file must not be able to replay our own scene at us either.
 */
export function digestFrames(
  frames: readonly BoardFrame[],
  opts: { selfDevice: string; participants: ParticipantMap; now: number; staleMs?: number },
): InboundFrames {
  const newest = new Map<string, BoardFrame>()
  const files: Record<string, unknown> = {}
  for (const f of frames) {
    if (!f || typeof f.device !== 'string' || f.device === opts.selfDevice) continue
    Object.assign(files, sanitizeSceneFiles(f.files))
    const prev = newest.get(f.device)
    if (!prev || (f.seq ?? 0) >= (prev.seq ?? 0)) newest.set(f.device, f)
  }

  const participants: ParticipantMap = { ...opts.participants }
  const batches: FrameBatch[] = []
  for (const [device, f] of [...newest.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const name = typeof f.name === 'string' && f.name.trim() ? f.name : device.slice(0, 8)
    const elements = safeElements(f.elements)
    if (elements) batches.push({ device, name, elements })
    participants[device] = {
      device,
      name,
      color: boardColor(device),
      pointer: safePointer(f.pointer),
      selectedIds: Array.isArray(f.selectedIds) ? f.selectedIds.filter((s): s is string => typeof s === 'string') : [],
      seenAt: opts.now,
    }
  }
  return { batches, files, participants: pruneParticipants(participants, opts.now, opts.staleMs) }
}

/**
 * `null` for a frame that is not a usable scene. A peer over the element cap is
 * dropped rather than thrown on: one hostile (or simply enormous) frame must
 * cost that participant their update, not everybody else their session. Same
 * ceiling as `sanitize.ts` uses for a received diagram message.
 */
function safeElements(raw: unknown): unknown[] | null {
  if (!Array.isArray(raw)) return null
  if (raw.length > MAX_SCENE_ELEMENTS) return null
  const out: unknown[] = []
  for (const el of raw) {
    if (el && typeof el === 'object' && typeof (el as { id?: unknown }).id === 'string') out.push(el)
  }
  return out
}

/**
 * Pointer coordinates are Excalidraw *scene* coordinates on the writer's side
 * and are passed through untouched — translating them through anybody's scroll
 * or zoom is exactly how a remote cursor ends up in the wrong place.
 */
function safePointer(raw: unknown): { x: number; y: number; tool: 'pointer' | 'laser' } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const p = raw as { x?: unknown; y?: unknown; tool?: unknown }
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return undefined
  return { x: p.x as number, y: p.y as number, tool: p.tool === 'laser' ? 'laser' : 'pointer' }
}

// ---------------------------------------------------------------------------
// Outbound: the echo guard, and which files still have to travel

/**
 * Has the scene actually moved since the last frame this device wrote?
 *
 * The signature is `sceneSignature`'s (element count + every version /
 * versionNonce), and it is what keeps a *received* frame from bouncing
 * straight back out: after a remote frame is reconciled into the canvas the
 * caller stores the reconciled signature, so the `onChange` that Excalidraw
 * fires for its own `updateScene` compares equal and writes nothing. A local
 * edit landing in the same tick changes the signature again and does write.
 */
export function sceneChanged(previous: string, next: string): boolean {
  return previous !== next
}

export interface FileTracker {
  /** id -> local ms when it was first put in a draft. */
  pending: Map<string, number>
  sent: Set<string>
}

export function newFileTracker(): FileTracker {
  return { pending: new Map(), sent: new Set() }
}

/** Files that arrived from a peer are already on the share; never send them back. */
export function markSent(tracker: FileTracker, ids: Iterable<string>): void {
  for (const id of ids) {
    tracker.pending.delete(id)
    tracker.sent.add(id)
  }
}

/**
 * Files main had to drop to fit the frame inside `BOARD.maxFrameBytes`: they
 * never reached the share, so they go back to square one — pending as of *now*,
 * and explicitly un-sent, so the next frames carry them again. Without this the
 * element that needed the image is a permanent blank on every peer's canvas,
 * and nothing ever says so.
 */
export function keepPending(tracker: FileTracker, ids: Iterable<string>, now: number): void {
  for (const id of ids) {
    if (typeof id !== 'string' || !id) continue
    tracker.sent.delete(id)
    tracker.pending.set(id, now)
  }
}

/**
 * The `files` to attach to the next outbound draft — new ones, plus anything
 * put in a draft so recently that it may not have survived main's coalescer.
 *
 * Main keeps only the *latest* draft per write window, so a draft that carried
 * an image and was superseded 200 ms later by a pointer-only draft would take
 * the image with it, and the receiver would draw that element as a permanent
 * blank. So an id stays in the outgoing set for one coalescing window (two
 * `BOARD.writeMinMs` by default) before it is considered delivered. Images are
 * re-sent for a second or two; a lost image is forever.
 */
export function selectNewFiles(
  tracker: FileTracker,
  files: Record<string, unknown>,
  now: number,
  graceMs: number = BOARD.writeMinMs * 2,
): Record<string, unknown> | undefined {
  for (const [id, firstAt] of [...tracker.pending.entries()]) {
    if (now - firstAt >= graceMs) {
      tracker.pending.delete(id)
      tracker.sent.add(id)
    }
  }
  const out: Record<string, unknown> = {}
  for (const [id, file] of Object.entries(files ?? {})) {
    if (tracker.sent.has(id)) continue
    if (!tracker.pending.has(id)) tracker.pending.set(id, now)
    out[id] = file
  }
  return Object.keys(out).length > 0 ? out : undefined
}

// ---------------------------------------------------------------------------
// The session registry (sys events)

export interface LiveBoardEntry {
  sessionId: string
  conv: ConvId
  /** The diagram message a Collaborate was seeded from, when there was one. */
  boardId?: string
  title: string
  host: string
  startedAt: number
  /** A `board-ended` was seen — or a join found the directory already gone. */
  ended: boolean
}

export type LiveBoardMap = Record<string, LiveBoardEntry>

/**
 * Fold `board-live` / `board-ended` sys events into the live-session registry.
 *
 * This is what puts a **Join** button on a sys row and takes it away again. An
 * ended session can never come back: `board-ended` for a session id not seen
 * yet leaves a tombstone, so the `board-live` row that arrives afterwards (a
 * catch-up read hands events over in id order, but a push need not) does not
 * resurrect it.
 *
 * Returns the same object when nothing changed, so the store can `set` only on
 * a real change.
 */
export function foldBoardEvents(map: LiveBoardMap, events: readonly VerifiedEvent[]): LiveBoardMap {
  let out = map
  const edit = (): LiveBoardMap => (out === map ? (out = { ...map }) : out)
  for (const ev of events) {
    if (ev.type !== 'sys' || !ev.verified) continue
    const p = ev.payload as SysPayload
    if (p.kind !== 'board-live' && p.kind !== 'board-ended') continue
    const data = (p.data ?? {}) as Record<string, unknown>
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
    if (!sessionId) continue
    const prev = out[sessionId]
    if (p.kind === 'board-ended') {
      if (prev?.ended) continue
      // Only the host ends a board. `board-ended` is a signed event like any
      // other, so the signer is known: a member who publishes one for somebody
      // else's session cannot take the Join button away (main refuses the same
      // event for the session itself — see boards.ts `resolve`).
      if (prev && prev.host && prev.host !== ev.author) continue
      edit()[sessionId] = {
        sessionId,
        conv: p.conv,
        title: prev?.title ?? (typeof data.title === 'string' ? data.title : ''),
        host: prev?.host ?? ev.author,
        boardId: prev?.boardId,
        startedAt: prev?.startedAt ?? 0,
        ended: true,
      }
      continue
    }
    if (prev && prev.startedAt > 0) continue // already indexed
    edit()[sessionId] = {
      sessionId,
      conv: p.conv,
      boardId: typeof data.boardId === 'string' ? data.boardId : undefined,
      title: typeof data.title === 'string' ? data.title : '',
      // The signer, never `data.host`: that field is written truthfully by
      // every client we ship and is still a field anyone could put any device
      // id into, and it decides whose `board-ended` counts (main made the same
      // call — see docs/contract-changes-1.3.md).
      host: ev.author,
      startedAt: typeof data.startedAt === 'number' ? data.startedAt : 0,
      ended: prev?.ended ?? false,
    }
  }
  return out
}

/** Mark a session dead without an event — a join that found no directory. */
export function endBoardIn(map: LiveBoardMap, sessionId: string): LiveBoardMap {
  const prev = map[sessionId]
  if (prev?.ended) return map
  return {
    ...map,
    [sessionId]: prev
      ? { ...prev, ended: true }
      : { sessionId, conv: '' as ConvId, title: '', host: '', startedAt: 0, ended: true },
  }
}

/**
 * The action a sys row carries, if any: a **Join** button on a `board-live`
 * row for as long as that session is alive. Pure so `MessageList` stays a
 * renderer of decisions rather than a maker of them.
 */
export function boardJoinAction(sys: SysView, boards: LiveBoardMap): { label: string; entry: LiveBoardEntry } | null {
  if (sys.kind !== 'board-live') return null
  const sessionId = typeof sys.data.sessionId === 'string' ? sys.data.sessionId : ''
  if (!sessionId) return null
  const entry = boards[sessionId]
  if (!entry || entry.ended) return null
  return { label: 'Join', entry }
}
