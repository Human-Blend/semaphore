import { randomBytes } from 'node:crypto'
import { BOARD, DIR, DST, KID, RETENTION } from '@shared/constants'
import { boardFrameFileName, isGrpConv, isTeamConv, parseBoardFrameFileName } from '@shared/ids'
import type {
  BoardFrame,
  BoardFrameDraft,
  ConvId,
  SignedRecord,
  SysPayload,
  VerifiedEvent,
} from '@shared/types'
import type { PushMessage } from '@shared/bridge'
import { buildAad, decryptRecord, encryptRecord, recordKid } from '../crypto/envelope'
import { signRecord, verifyRecord } from '../crypto/identity'
import type { EventStore } from '../transport/events'
import type { ConvInfo, Session } from '../transport/session'
import type { IoTier } from './ioTier'

// Live boards (1.3): a real-time diagram session carried by the shared folder,
// built like the screen-share relay rather than like a conversation log.
//
//   boards/<sessionId>/<deviceId8>.<seq base36>
//
// One file per participant, the sequence in the name, and the writer deletes
// its previous file right after the rename — so a single readdir shows every
// participant's latest state, and a joiner's first read is the whole session.
// Frames are signed then encrypted under the CONVERSATION key (channel, DM or
// private group — `convInfo` answers for all four kinds), with
// `KID.board(sessionId, convInfo.kid)` and AAD binding the frame to its path
// and file name: a frame moved into another session's directory, or renamed to
// another device's slot, fails authentication before anything looks at its
// contents. The conversation's kid inside the frame's is what lets a reader
// that has not yet been handed a group's new epoch key park the frame and
// retry, instead of dropping every frame written after a rekey.
//
// The file NAMES are metadata: any team member can list `boards/<sid>/` and see
// which devices are in a session (that is what makes one readdir enough to find
// every participant's latest state). What is in the board, and which
// conversation it belongs to, stay inside the envelope.
//
// The session itself is announced in the conversation's own log (`board-live`
// / `board-ended` sys events), so joining, ending and "is it still alive" all
// ride machinery that already exists. Nothing here writes into an event log
// except those two announcements.

/** What this service needs from ChatService (injected so tests need no window). */
export interface BoardHost {
  readonly events: EventStore
  /** Ring a published announcement into the beacon so peers ingest it at once. */
  noteOwnEvent(conv: ConvId, fileName: string): void
  /** Current share-I/O tier — the frame poller follows ChatService's (1.2). */
  tier(): IoTier
}

/** Thrown (and pushed) when a session is over: dir gone or host ended it. */
export const BOARD_ENDED = 'board-ended'
/** Thrown by `write` when even a file-less frame is over the budget. */
export const FRAME_TOO_LARGE = 'frame-too-large'

/**
 * A session id is `deviceId8` + 8 random hex: 16 hex characters, and the first
 * eight of them are the host's device. That shape is load-bearing twice over.
 *
 * It is a *path segment* (`boards/<sessionId>/…`), so anything else — `..`
 * above all — has no business reaching `ShareIo`. And because the host's
 * device id is baked into it, a `board-live` announcing a session id that does
 * not start with the announcer's own device is a forgery: nobody can claim a
 * seat in someone else's session id space, which is what stopped a duplicate
 * announcement from stealing the host's seat.
 */
const SESSION_ID_RE = /^[0-9a-f]{16}$/

/** `<hlcMs 13>-<ctr 4>-<deviceId8>` — an event stem, nothing else. */
const RESULT_STEM_RE = /^\d{13}-\d{4}-[0-9a-f]{8}$/

/**
 * Per-reader memory of frame files that decrypted and were then refused, so a
 * junk file does not cost a read on every poll. Bounded: a writer that can
 * plant files can otherwise grow this without limit. Oldest entry goes first.
 */
const REJECTED_MAX = 64

/** How long an ended session stays in the map before it is pruned (1.3). */
const ENDED_GRACE_MS = 5 * 60_000

/** True for a well-formed session id. Exported so the IPC slice can refuse early. */
export function isBoardSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId)
}

/** Throwing form of {@link isBoardSessionId} — every `boards:*` entry point starts here. */
export function assertBoardSessionId(sessionId: unknown): string {
  if (!isBoardSessionId(sessionId)) throw new Error('bad-session-id')
  return sessionId
}

/**
 * Is a `board-live` we just ingested worth a toast? A board can only be joined
 * while it is running, and catching up a week-old log (or a conversation nobody
 * opened since Friday) would otherwise toast sessions the janitor has already
 * swept. Pure so chatService can stay one line.
 */
export function boardLiveIsFresh(startedAt: number, now: number): boolean {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return false
  return now - startedAt < RETENTION.boardsDeadMinutes * 60_000
}

/**
 * Room left for the frame's own envelope fields (sessionId, device, name, seq,
 * at) and the signature wrapper around them, so `BOARD.maxFrameBytes` is a
 * budget for what actually lands on the share rather than for the draft alone.
 */
const FRAME_ENVELOPE_BYTES = 512

/** Longest display name a frame may carry into the collaborator list. */
const NAME_MAX = 60

/** What we know about a session, from our own `start` or an ingested announcement. */
interface BoardSessionInfo {
  sessionId: string
  conv: ConvId
  /** The signer of `board-live`: the only device whose `board-ended` counts. */
  host: string
  boardId?: string
  title: string
  startedAt: number
  ended: boolean
  /** When we learned it ended — an ended session is pruned after a grace. */
  endedAt?: number
}

interface WriterState {
  sessionId: string
  conv: ConvId
  seq: number
  /**
   * False until the directory has been read once: a writer that rejoins (or
   * comes back after a crash) must not restart at seq 0, which a peer that
   * stayed in the session reads as a file it has already delivered.
   */
  seeded: boolean
  pending: BoardFrameDraft | null
  pendingContentSig: string
  pendingPointerSig: string
  contentSig: string
  pointerSig: string
  /** The last frame actually published — what a keepalive re-sends. */
  lastFrame: BoardFrameDraft | null
  lastFileName: string | null
  lastPublishAt: number
  lastPointerAt: number
  flush: NodeJS.Timeout | null
  flushDueAt: number
  keepalive: NodeJS.Timeout | null
  /** Publishes are chained: seq order and the delete-previous must not interleave. */
  publishing: Promise<void>
}

interface ReaderState {
  sessionId: string
  conv: ConvId
  /**
   * The seq last *delivered* per peer device. Compared with `!==`, never `>=`:
   * a writer that rejoined seeds its seq from the share and a restart can land
   * it below what we already delivered, which is still news.
   */
  seqByDevice: Map<string, number>
  /** File names decrypted and refused — never read again (bounded, FIFO). */
  rejected: Set<string>
  timer: NodeJS.Timeout | null
}

/** What one candidate file turned into. Only `ok` moves the per-device cursor. */
type FrameVerdict =
  | { verdict: 'ok'; frame: BoardFrame }
  /** Gone from under us mid-poll (a writer's delete landed): retry next pass. */
  | { verdict: 'gone' }
  /** Present, but no key for it yet (a group rekey in flight): retry next pass. */
  | { verdict: 'pending' }
  /** Decrypted (or failed to) and refused: it will never become valid. */
  | { verdict: 'refused' }

/**
 * Signature of everything that is *scene* in a draft: per-element identity and
 * version (Excalidraw's own conflict rule is version/versionNonce, so this is
 * exactly what a peer would reconcile) plus the set of file ids. Cheap enough
 * to run on every `onChange` the renderer forwards.
 */
export function contentSignature(draft: BoardFrameDraft): string {
  const parts: string[] = []
  for (const raw of draft.elements ?? []) {
    const el = raw as { id?: unknown; version?: unknown; versionNonce?: unknown; isDeleted?: unknown }
    parts.push(`${String(el.id)}:${String(el.version)}:${String(el.versionNonce)}:${el.isDeleted ? 1 : 0}`)
  }
  const files = draft.files ? Object.keys(draft.files).sort().join(',') : ''
  return `${parts.length}|${parts.join(',')}|${files}`
}

/** Signature of the presence half — pointer and selection move far more often. */
export function pointerSignature(draft: BoardFrameDraft): string {
  const p = draft.pointer
  const ptr = p ? `${Math.round(p.x)},${Math.round(p.y)},${p.tool}` : '-'
  return `${ptr}|${[...(draft.selectedIds ?? [])].sort().join(',')}`
}

/**
 * The `board-live` toast, as a pure function (chatService owns the wiring).
 * With previews off nothing about the board — not the host, not the
 * conversation, not the title — leaves the app, exactly like a message.
 */
export function boardLiveNotifyLine(input: {
  who: string
  /** Where it happened, already decorated: "#design", "🔒 Design crew", "Direct message". */
  where: string
  title?: string
  previews: boolean
}): { title: string; body: string } {
  if (!input.previews) return { title: 'Chat', body: 'New live board' }
  const t = (input.title ?? '').trim().slice(0, 80)
  return { title: input.where, body: `${input.who} opened a live board${t ? `: ${t}` : ''}` }
}

export class BoardService {
  /**
   * Keyed by `conv|sessionId`, not by session id alone: the id is announced in
   * a conversation and means nothing outside it, so a `board-live` in one
   * conversation must not be able to touch (or end) what another one knows.
   */
  private sessions = new Map<string, BoardSessionInfo>()
  /** The conversation a session id was started or joined in — `write`/`leave`/`end` must agree. */
  private convOf = new Map<string, ConvId>()
  /** `conv|sessionId` pairs the log has already been searched for, in vain. */
  private resolveMisses = new Set<string>()
  private writers = new Map<string, WriterState>()
  private readers = new Map<string, ReaderState>()

  constructor(
    private session: Session,
    private host: BoardHost,
    private push: (msg: PushMessage) => void,
  ) {
    // `board-ended` reaches us the same way any other sys event does: through
    // the ordinary ingest path. No extra polling, and it works whether the
    // host is in this conversation's channel, a DM or a private group.
    host.events.onEvent((conv, event) => this.onEvent(conv, event))
  }

  /**
   * Drop every timer and leave every session this device is in: the window
   * closed, the team folder changed, or we are quitting. Owned by
   * AppController (and `mainWindow.on('closed')`), because a board's timers
   * outliving the share they poll is exactly how a closed window kept writing
   * frames into a folder nobody was looking at.
   *
   * Deleting our own files is the same courtesy `leave` does: peers drop us
   * from the pointer list at once instead of waiting out `BOARD.staleMs`.
   * Never rejects — callers are shutdown paths.
   */
  async stop(): Promise<void> {
    const mine = new Set([...this.readers.keys(), ...this.writers.keys()])
    const chains: Promise<void>[] = []
    for (const id of mine) {
      const w = this.writers.get(id)
      if (w) chains.push(w.publishing.catch(() => {}))
      this.stopReader(id)
      this.stopWriter(id)
    }
    await Promise.all(chains)
    for (const id of mine) await this.deleteOwnFiles(id).catch(() => {})
  }

  /** What this device knows about a session — the renderer never needs it; tests do. */
  info(conv: ConvId, sessionId: string): Readonly<BoardSessionInfo> | null {
    return this.sessions.get(key(conv, sessionId)) ?? null
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  async start(conv: ConvId, title: string, boardId?: string): Promise<{ sessionId: string }> {
    // A team conversation is the calendar and the PR config: LWW-materialized
    // app state with no members to collaborate with and a janitor that never
    // sweeps it. A board there would be a directory nobody ever cleans up.
    if (isTeamConv(conv)) throw new Error('unsupported-conversation')
    if (!this.session.convInfo(conv)) throw new Error('unknown-conversation')
    this.pruneEnded()
    // One live session per device per conversation: the cap that stops a stuck
    // renderer (or a held-down button) from filling the share with dirs only the
    // janitor will ever close. "Live" means this device is still in it — a
    // reader or a writer — because that is what an open editor holds: the host
    // joins its own session to see everyone else's frames. Once the editor is
    // gone (leave, window closed, team folder changed) a new board in the same
    // conversation is the user asking for a new board, not a runaway.
    for (const s of this.sessions.values()) {
      if (s.conv !== conv || s.host !== this.session.deviceId || s.ended) continue
      if (this.readers.has(s.sessionId) || this.writers.has(s.sessionId)) throw new Error('board-already-live')
    }
    // First eight characters are this device: a `board-live` whose session id
    // does not start with its author's device id is refused everywhere (see
    // SESSION_ID_RE), so no one else can announce — or end — this session.
    const sessionId = `${this.session.deviceId8}${randomBytes(4).toString('hex')}`
    const startedAt = this.session.io.calibratedNow()
    const clean = title.trim().slice(0, 80)
    const payload: SysPayload = {
      t: 'sys',
      conv,
      kind: 'board-live',
      data: {
        sessionId,
        ...(boardId ? { boardId } : {}),
        title: clean,
        host: this.session.deviceId,
        startedAt,
      },
    }
    // The directory exists before the announcement does: a peer that reads the
    // sys event immediately and joins must not race an ENOENT into "ended".
    await this.session.io.ensureDir(`${DIR.boards}/${sessionId}`)
    const ev = await this.host.events.publish(conv, 'sys', payload)
    this.host.noteOwnEvent(conv, `${ev.id}.sys.e1`)
    this.sessions.set(key(conv, sessionId), {
      sessionId,
      conv,
      host: this.session.deviceId,
      boardId,
      title: clean,
      startedAt,
      ended: false,
    })
    this.convOf.set(sessionId, conv)
    this.resolveMisses.delete(key(conv, sessionId))
    return { sessionId }
  }

  /**
   * Read every frame currently in the session directory, then keep polling.
   * Throws `board-ended` when the directory is already gone — the session is
   * over and the caller marks it so rather than waiting for a push.
   */
  async join(sessionId: string, conv: ConvId): Promise<{ frames: BoardFrame[] }> {
    assertBoardSessionId(sessionId)
    if (!this.session.convInfo(conv)) throw new Error('unknown-conversation')
    this.requireConv(sessionId, conv)
    this.pruneEnded()
    if (this.resolve(sessionId, conv)?.ended) throw new Error(BOARD_ENDED)
    // A re-join always answers with the whole session, never with "nothing new
    // since last time": the caller is rebuilding its canvas from zero.
    this.stopReader(sessionId)
    const st: ReaderState = { sessionId, conv, seqByDevice: new Map(), rejected: new Set(), timer: null }
    this.readers.set(sessionId, st)
    let frames: BoardFrame[]
    try {
      frames = await this.collect(st)
    } catch (err) {
      this.stopReader(sessionId)
      throw err
    }
    this.convOf.set(sessionId, conv)
    this.schedulePoll(sessionId)
    // One frame straight away, before the renderer has drawn anything: the
    // keepalive is armed by a publish, so a pure watcher that never touches the
    // canvas used to be invisible to everyone else for the whole session.
    await this.publishPresence(sessionId, conv).catch(() => {})
    return { frames }
  }

  /** Stop polling and remove this device's frame file. Idempotent. */
  async leave(sessionId: string, conv: ConvId): Promise<void> {
    assertBoardSessionId(sessionId)
    this.requireConv(sessionId, conv)
    // Drain whatever is mid-flight first: a publish that lands *after* the
    // delete leaves this device's last frame on the share for the janitor.
    const chain = this.writers.get(sessionId)?.publishing
    this.stopReader(sessionId)
    this.stopWriter(sessionId)
    await chain?.catch(() => {})
    await this.deleteOwnFiles(sessionId)
  }

  /**
   * End the session for everyone. Only the device that published `board-live`
   * may: the signer of that event is the host, and nothing else counts.
   */
  async end(sessionId: string, conv: ConvId, resultStem?: string): Promise<void> {
    assertBoardSessionId(sessionId)
    this.requireConv(sessionId, conv)
    // The stem names a message every member will look up; it is chosen by the
    // renderer from a `chat.send` result, and anything that is not an event
    // stem has no business being published as one.
    if (resultStem !== undefined && !RESULT_STEM_RE.test(resultStem)) throw new Error('bad-result-stem')
    const info = this.resolve(sessionId, conv)
    if (!info) throw new Error('unknown-session')
    if (info.host !== this.session.deviceId) throw new Error('not-host')
    // Drain before the dir goes: a publish still in flight would otherwise
    // recreate it (and a frame nobody can end) right after the delete.
    const chain = this.writers.get(sessionId)?.publishing
    this.stopWriter(sessionId)
    await chain?.catch(() => {})
    const payload: SysPayload = {
      t: 'sys',
      conv,
      kind: 'board-ended',
      data: {
        sessionId,
        ...(info.boardId ? { boardId: info.boardId } : {}),
        ...(resultStem ? { resultStem } : {}),
      },
    }
    const ev = await this.host.events.publish(conv, 'sys', payload)
    this.host.noteOwnEvent(conv, `${ev.id}.sys.e1`)
    // Publishing already ran our own listener (marking the session ended and
    // pushing `board-ended` to this renderer); the directory goes last so a
    // peer mid-read sees a clean disappearance rather than a half-empty dir.
    info.ended = true
    info.endedAt = this.session.io.calibratedNow()
    await this.session.io.delete(`${DIR.boards}/${sessionId}`).catch(() => {})
  }

  /**
   * The conversation a session id belongs to, as recorded by `start`/`join`.
   * Everything else must name the same one: the frame's AAD and key come from
   * the conversation, so a `write` that names a *different* conv would encrypt
   * this session's frames under another conversation's key — unreadable by the
   * people in the board, readable by people who are not.
   */
  private requireConv(sessionId: string, conv: ConvId): void {
    const bound = this.convOf.get(sessionId) ?? this.readers.get(sessionId)?.conv ?? this.writers.get(sessionId)?.conv
    if (bound && bound !== conv) throw new Error('conv-mismatch')
  }

  /** Forget sessions that ended a while ago — the map is otherwise append-only. */
  private pruneEnded(): void {
    const now = this.session.io.calibratedNow()
    for (const [k, s] of [...this.sessions.entries()]) {
      if (!s.ended) continue
      if (this.readers.has(s.sessionId) || this.writers.has(s.sessionId)) continue
      if (now - (s.endedAt ?? s.startedAt) < ENDED_GRACE_MS) continue
      this.sessions.delete(k)
      this.convOf.delete(s.sessionId)
    }
  }

  // -------------------------------------------------------------------------
  // Writing

  /**
   * Queue a frame. Nothing is written here: the latest draft wins and the
   * timer publishes at most one frame per `BOARD.writeMinMs` (pointer-only
   * changes at most one per `BOARD.pointerMinMs`), so a renderer that calls
   * this on every stroke costs one file per second, not one per stroke.
   *
   * Resolves with the `files` ids the budget made us drop (1.3), so the caller
   * can re-offer them on a later frame instead of leaving a peer with a shape
   * that never gets its image.
   */
  async write(sessionId: string, conv: ConvId, draft: BoardFrameDraft): Promise<{ droppedFiles: string[] }> {
    assertBoardSessionId(sessionId)
    this.requireConv(sessionId, conv)
    if (this.resolve(sessionId, conv)?.ended) throw new Error(BOARD_ENDED)
    const fit = fitFrame(draft) // throws frame-too-large — never a partial scene
    const fitted = fit.frame
    const w = this.writer(sessionId, conv)
    const contentSig = contentSignature(fitted)
    const pointerSig = pointerSignature(fitted)
    const contentChanged = contentSig !== w.contentSig
    const pointerChanged = pointerSig !== w.pointerSig
    // Nothing changed at all: the keepalive already tells everyone we're here.
    if (!contentChanged && !pointerChanged) return { droppedFiles: fit.droppedFiles }
    w.pending = fitted
    w.pendingContentSig = contentSig
    w.pendingPointerSig = pointerSig
    const due = contentChanged
      ? w.lastPublishAt + BOARD.writeMinMs
      : Math.max(w.lastPublishAt + BOARD.writeMinMs, w.lastPointerAt + BOARD.pointerMinMs)
    this.scheduleFlush(w, due)
    return { droppedFiles: fit.droppedFiles }
  }

  /** Publish any queued frame now. Used by tests and before a session ends. */
  async flushWrites(sessionId?: string): Promise<void> {
    const states = sessionId
      ? ([this.writers.get(sessionId)].filter(Boolean) as WriterState[])
      : [...this.writers.values()]
    for (const w of states) {
      if (w.flush) clearTimeout(w.flush)
      w.flush = null
      w.flushDueAt = 0
      this.flush(w)
      await w.publishing
    }
  }

  private writer(sessionId: string, conv: ConvId): WriterState {
    const existing = this.writers.get(sessionId)
    if (existing) return existing
    const w: WriterState = {
      sessionId,
      conv,
      seq: 0,
      seeded: false,
      pending: null,
      pendingContentSig: '',
      pendingPointerSig: '',
      contentSig: '',
      pointerSig: '',
      lastFrame: null,
      lastFileName: null,
      lastPublishAt: 0,
      lastPointerAt: 0,
      flush: null,
      flushDueAt: 0,
      keepalive: null,
      publishing: Promise.resolve(),
    }
    this.writers.set(sessionId, w)
    // The seq comes off the share, not from zero — chained ahead of every
    // publish, so the first frame already carries one no peer has seen.
    w.publishing = this.seedWriter(w)
    return w
  }

  /**
   * Read the session directory once, before this device's first publish: take
   * the next seq from the highest file we already own and delete the old ones.
   *
   * Two bugs live here. A writer that leaves and rejoins (or crashes and comes
   * back) restarts its counter at 0, and a peer still in the session has
   * already delivered seq 0 — so every frame of the new run is invisible to it.
   * And a crash between the publish and the delete-previous leaves two files in
   * one slot, which is a state a joiner's single readdir is not supposed to see.
   */
  private async seedWriter(w: WriterState): Promise<void> {
    if (w.seeded) return
    w.seeded = true
    const s = this.session
    const dir = `${DIR.boards}/${w.sessionId}`
    const names = await s.io.list(dir).catch(() => [] as string[])
    let maxOwn = -1
    const mine: string[] = []
    for (const n of names) {
      const p = parseBoardFrameFileName(n)
      if (!p || p.deviceId8 !== s.deviceId8) continue
      mine.push(n)
      if (p.seq > maxOwn) maxOwn = p.seq
    }
    w.seq = maxOwn + 1
    for (const n of mine) await s.io.delete(`${dir}/${n}`).catch(() => {})
  }

  /**
   * One frame right after a join, so a participant who only ever watches still
   * appears in everyone's pointer list (and keeps appearing — the keepalive is
   * armed by a publish, not by joining). The host path publishes its scene
   * anyway; this is the watcher's equivalent.
   */
  private async publishPresence(sessionId: string, conv: ConvId): Promise<void> {
    const w = this.writer(sessionId, conv)
    if (w.lastFrame || w.pending) return // already drawing: nothing to announce
    this.enqueuePublish(w, { elements: [] })
    await w.publishing
  }

  private scheduleFlush(w: WriterState, dueAt: number): void {
    // An earlier deadline wins: a scene edit must not sit behind a pointer
    // move's two-second timer.
    if (w.flush && w.flushDueAt <= dueAt) return
    if (w.flush) clearTimeout(w.flush)
    w.flushDueAt = dueAt
    w.flush = setTimeout(() => {
      w.flush = null
      w.flushDueAt = 0
      this.flush(w)
    }, Math.max(0, dueAt - Date.now()))
    w.flush.unref?.()
  }

  private flush(w: WriterState): void {
    const draft = w.pending
    if (!draft) return
    w.pending = null
    w.contentSig = w.pendingContentSig
    w.pointerSig = w.pendingPointerSig
    this.enqueuePublish(w, draft)
  }

  private enqueuePublish(w: WriterState, draft: BoardFrameDraft): void {
    // Stamp the rate clock when the frame is *queued*, not when the share
    // finally takes it: on a slow mount a publish can take longer than
    // `writeMinMs`, and dating the window from its completion let a backlog of
    // writes go out back-to-back the moment it cleared.
    w.lastPublishAt = Date.now()
    if (draft.pointer) w.lastPointerAt = w.lastPublishAt
    w.publishing = w.publishing
      .then(() => this.publishFrame(w, draft))
      .catch(() => {
        // The share blinked. Forget what we believe peers already have, so the
        // next identical draft is re-sent rather than coalesced away as
        // "nothing changed" — a dropped frame must not cost the whole scene.
        w.contentSig = ''
        w.pointerSig = ''
      })
  }

  private async publishFrame(w: WriterState, draft: BoardFrameDraft): Promise<void> {
    const info = this.session.convInfo(w.conv)
    if (!info) return
    const s = this.session
    const dir = `${DIR.boards}/${w.sessionId}`
    // `io.publish` mkdir -p's its way to the file, which would resurrect a
    // session the host ended (or the janitor swept) as a directory nobody can
    // close again. A missing directory IS the end of the session.
    if (!(await s.io.statMaybe(dir))) {
      this.endedLocally(w.sessionId, w.conv)
      throw new Error(BOARD_ENDED)
    }
    const seq = w.seq++
    const fileName = boardFrameFileName(s.deviceId, seq)
    const rel = `${dir}/${fileName}`
    const frame: BoardFrame = {
      ...draft,
      sessionId: w.sessionId,
      device: s.deviceId,
      name: s.displayName.slice(0, NAME_MAX),
      seq,
      at: s.io.calibratedNow(),
    }
    const signed = signRecord(s.identity, DST.record, frame)
    const aad = buildAad('board', rel, fileName)
    // The conversation's kid rides in the frame's: for a private group it names
    // the epoch, which is the only way a reader that has not yet been handed
    // the new key can tell "retry when it arrives" from "refuse this".
    const kid = KID.board(w.sessionId, info.kid)
    const buf = encryptRecord(info.key, kid, Buffer.from(JSON.stringify(signed), 'utf8'), aad)
    await s.io.publish(rel, buf)
    const previous = w.lastFileName
    w.lastFileName = fileName
    w.lastFrame = draft
    w.lastPublishAt = Date.now()
    if (draft.pointer) w.lastPointerAt = w.lastPublishAt
    this.armKeepalive(w)
    // One writer per file, ever: only this device ever publishes or deletes
    // its own slot, so the previous seq goes as soon as the new one is named.
    if (previous && previous !== fileName) {
      await s.io.delete(`${dir}/${previous}`).catch(() => {})
    }
  }

  /**
   * Re-publish the last frame when nothing has changed for `BOARD.keepaliveMs`
   * — that is what keeps this device in everyone else's pointer list, which
   * drops a participant silent for `BOARD.staleMs`.
   */
  private armKeepalive(w: WriterState): void {
    if (w.keepalive) clearTimeout(w.keepalive)
    w.keepalive = setTimeout(() => {
      w.keepalive = null
      if (!this.writers.has(w.sessionId) || !w.lastFrame) return
      // Paused is a locked or suspended machine: no share I/O at all, the same
      // rule the frame poller follows. Re-arm rather than give up, so coming
      // back puts this device in everyone's pointer list again without a
      // re-join — and so a laptop that slept for an hour did not spend it
      // publishing a keepalive a second.
      if (this.host.tier() === 'paused') {
        this.armKeepalive(w)
        return
      }
      this.enqueuePublish(w, w.lastFrame)
    }, BOARD.keepaliveMs)
    w.keepalive.unref?.()
  }

  private stopWriter(sessionId: string): void {
    const w = this.writers.get(sessionId)
    if (!w) return
    if (w.flush) clearTimeout(w.flush)
    if (w.keepalive) clearTimeout(w.keepalive)
    w.flush = null
    w.keepalive = null
    w.pending = null
    this.writers.delete(sessionId)
  }

  private async deleteOwnFiles(sessionId: string): Promise<void> {
    const dir = `${DIR.boards}/${sessionId}`
    const s = this.session
    // One readdir on the way out covers the file we know about and anything a
    // previous run of this device left behind (its seq counter died with it).
    const names = await s.io.list(dir).catch(() => [] as string[])
    for (const n of names) {
      const p = parseBoardFrameFileName(n)
      if (p?.deviceId8 === s.deviceId8) await s.io.delete(`${dir}/${n}`).catch(() => {})
    }
  }

  // -------------------------------------------------------------------------
  // Reading

  /** One poll pass: readdir, read what advanced, push. Exposed for tests. */
  async pollOnce(sessionId: string): Promise<void> {
    const st = this.readers.get(sessionId)
    if (!st) return
    if (this.sessions.get(key(st.conv, sessionId))?.ended) {
      this.endedLocally(sessionId, st.conv)
      return
    }
    let frames: BoardFrame[]
    try {
      frames = await this.collect(st)
    } catch (err) {
      if ((err as Error).message === BOARD_ENDED) {
        this.endedLocally(sessionId, st.conv)
        return
      }
      return // transient share trouble: the next tick tries again
    }
    if (frames.length) this.push({ kind: 'board-frames', sessionId, frames })
  }

  private schedulePoll(sessionId: string): void {
    const st = this.readers.get(sessionId)
    if (!st) return
    if (st.timer) clearTimeout(st.timer)
    // Three tiers reach here, and all three are spelled out: 'idle' (the window
    // visible but untouched for minutes) polls on the blurred cadence rather
    // than the idle *budget*, because the live editor being open is itself a
    // statement that the user is watching. 'paused' never gets this far —
    // `tick` skips the pass and re-arms.
    const tier = this.host.tier()
    const delay = tier === 'focused' ? BOARD.pollFocusedMs : BOARD.pollBlurredMs
    st.timer = setTimeout(() => void this.tick(sessionId), delay)
    st.timer.unref?.()
  }

  private async tick(sessionId: string): Promise<void> {
    const st = this.readers.get(sessionId)
    if (!st) return
    st.timer = null
    // Paused means a locked or suspended machine: no share I/O at all. The
    // timer stays so the session picks itself back up when the tier returns,
    // without the renderer having to re-join.
    if (this.host.tier() !== 'paused') await this.pollOnce(sessionId)
    if (this.readers.has(sessionId)) this.schedulePoll(sessionId)
  }

  /**
   * Everything in the directory that advanced since the last pass. Only the
   * newest file per device is read — a writer deletes its previous seq, so an
   * older one still visible is a delete that hasn't landed yet, never news.
   */
  private async collect(st: ReaderState): Promise<BoardFrame[]> {
    const s = this.session
    const info = s.convInfo(st.conv)
    if (!info) throw new Error('unknown-conversation')
    const dir = `${DIR.boards}/${st.sessionId}`
    const names = await s.io.list(dir)
    if (names.length === 0) {
      // Empty is normal right after `start`; gone means the host ended it.
      if (!(await s.io.statMaybe(dir))) throw new Error(BOARD_ENDED)
      return []
    }
    // Every candidate per device, newest seq first — not just the newest file.
    // A single junk file (anyone in the team can write into the directory; only
    // the conversation key decides what *reads*) planted at a high seq used to
    // mute that device for the rest of the session: it was the only file
    // considered, and the cursor advanced past it anyway. Now we walk down the
    // device's files until one is good, and a refused name is remembered so it
    // costs one read, once.
    const byDevice = new Map<string, { seq: number; fileName: string }[]>()
    for (const n of names) {
      const p = parseBoardFrameFileName(n)
      if (!p || p.deviceId8 === s.deviceId8) continue
      if (st.rejected.has(n)) continue
      const arr = byDevice.get(p.deviceId8) ?? []
      arr.push({ seq: p.seq, fileName: n })
      byDevice.set(p.deviceId8, arr)
    }
    const out: BoardFrame[] = []
    for (const [device8, candidates] of [...byDevice.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      candidates.sort((a, b) => b.seq - a.seq)
      const delivered = st.seqByDevice.get(device8)
      for (const { seq, fileName } of candidates) {
        // `!==`, not `>=`: a writer that rejoined seeded its seq from the share
        // and may legitimately be *below* what we delivered in its last run.
        // Reaching the seq we already have means there is nothing newer here.
        if (delivered !== undefined && delivered === seq) break
        const read = await this.readFrame(st, dir, device8, fileName, info, seq)
        // 'gone' is a delete that landed mid-poll and 'pending' a key that has
        // not arrived yet (a group rekey in flight): both leave the cursor alone
        // so the next pass retries. 'refused' means we opened it and it lied —
        // the AAD binds it to this exact name, so it will never become valid:
        // remember the name and fall through to this device's next file.
        if (read.verdict === 'gone' || read.verdict === 'pending') continue
        if (read.verdict === 'refused') {
          this.noteRejected(st, fileName)
          continue
        }
        st.seqByDevice.set(device8, seq)
        out.push(read.frame)
        break
      }
    }
    return out.sort((a, b) => a.at - b.at || a.seq - b.seq)
  }

  /** Remember a refused file name, oldest first out (bounded per reader). */
  private noteRejected(st: ReaderState, fileName: string): void {
    st.rejected.add(fileName)
    while (st.rejected.size > REJECTED_MAX) {
      const oldest = st.rejected.values().next().value as string | undefined
      if (oldest === undefined) break
      st.rejected.delete(oldest)
    }
  }

  /**
   * Which key does this frame want? The conversation's current one, normally.
   * A private group rotates keys under a stable conversation, so a frame can
   * name an epoch this device has not been handed yet — its kid says which —
   * and that is the one case where "I cannot read this" must not mean "this is
   * junk": the rekey DM may still be in flight, and a rejection would drop
   * every frame for the rest of the session.
   */
  private keyForFrame(conv: ConvId, sessionId: string, kid: string, info: ConvInfo): Buffer | 'pending' | null {
    const prefix = `board/${sessionId}/`
    if (!kid.startsWith(prefix)) return null
    const convKid = kid.slice(prefix.length)
    if (convKid === info.kid) return info.key
    if (!isGrpConv(conv)) return null
    const lookup = this.session.groups?.keyForKid(conv, convKid) ?? { kind: 'reject' as const }
    if (lookup.kind === 'key') return lookup.key
    return lookup.kind === 'unknown-epoch' ? 'pending' : null
  }

  private async readFrame(
    st: ReaderState,
    dir: string,
    device8: string,
    fileName: string,
    info: ConvInfo,
    seq: number,
  ): Promise<FrameVerdict> {
    const s = this.session
    const rel = `${dir}/${fileName}`
    const buf = await s.io.readMaybe(rel).catch(() => null)
    if (!buf) return { verdict: 'gone' }
    try {
      const key = this.keyForFrame(st.conv, st.sessionId, recordKid(buf), info)
      if (key === 'pending') return { verdict: 'pending' }
      if (!key) return { verdict: 'refused' }
      const aad = buildAad('board', rel, fileName)
      const plain = decryptRecord(buf, key, aad)
      const signed = JSON.parse(plain.toString('utf8')) as SignedRecord<BoardFrame>
      // The slot in the file name is a claim about who wrote it; the signature
      // is the proof. Both must name the same device, and the frame's own
      // `device` field — what the renderer colours and labels by — with them.
      if (typeof signed.by !== 'string' || !signed.by.startsWith(device8)) return { verdict: 'refused' }
      let author = s.roster.get(signed.by)
      if (!author) author = (await s.roster.loadOne(signed.by)) ?? undefined
      if (!author || !verifyRecord(signed, DST.record, author.edPubKey)) return { verdict: 'refused' }
      const frame = signed.p
      if (!frame || typeof frame !== 'object') return { verdict: 'refused' }
      if (frame.device !== signed.by) return { verdict: 'refused' }
      if (frame.sessionId !== st.sessionId) return { verdict: 'refused' }
      // The seq is in the file name and in the frame, and the reader's cursor
      // moves by the name: a frame whose own seq disagrees would be delivered
      // under a number it never claimed.
      if (frame.seq !== seq) return { verdict: 'refused' }
      if (!Array.isArray(frame.elements)) return { verdict: 'refused' }
      return { verdict: 'ok', frame: { ...frame, name: String(frame.name ?? '').slice(0, NAME_MAX) } }
    } catch {
      return { verdict: 'refused' } // auth failure / corrupt — dropped for good
    }
  }

  private stopReader(sessionId: string): void {
    const st = this.readers.get(sessionId)
    if (!st) return
    if (st.timer) clearTimeout(st.timer)
    this.readers.delete(sessionId)
  }

  /** The session is over for this device: stop reading and say so once. */
  private endedLocally(sessionId: string, conv: ConvId): void {
    const joined = this.readers.has(sessionId)
    const known = this.sessions.get(key(conv, sessionId))
    if (known && !known.ended) {
      known.ended = true
      known.endedAt = this.session.io.calibratedNow()
    }
    this.stopReader(sessionId)
    this.stopWriter(sessionId)
    if (joined) this.push({ kind: BOARD_ENDED, sessionId })
  }

  // -------------------------------------------------------------------------
  // Announcements

  private onEvent(conv: ConvId, event: VerifiedEvent): void {
    if (event.type !== 'sys') return
    const p = event.payload as SysPayload
    if (p.kind !== 'board-live' && p.kind !== 'board-ended') return
    const data = (p.data ?? {}) as Record<string, unknown>
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
    // A malformed id never becomes a session: it is a path segment, and a
    // `board-live` carrying `../..` must not reach the share at all.
    if (!isBoardSessionId(sessionId)) return
    // Both announcements are authorization, not gossip: an unverified record
    // has no author to hold to either rule below.
    if (!event.verified) return
    const k = key(conv, sessionId)
    if (p.kind === 'board-live') {
      // The id's first eight characters are its creator's device (see
      // SESSION_ID_RE). A second `board-live` for someone else's session id —
      // the way a duplicate announcement used to take the host seat, and with
      // it the right to end the board — cannot name itself the author.
      if (!event.author.startsWith(sessionId.slice(0, 8))) return
      if (this.sessions.has(k)) return // first announcement wins
      this.sessions.set(k, {
        sessionId,
        conv,
        // The signer, not `data.host`: a member could name anyone there, and
        // this is the field that decides whose `board-ended` is obeyed.
        host: event.author,
        boardId: typeof data.boardId === 'string' ? data.boardId : undefined,
        title: typeof data.title === 'string' ? data.title : '',
        startedAt: typeof data.startedAt === 'number' ? data.startedAt : 0,
        ended: false,
      })
      this.resolveMisses.delete(k)
      return
    }
    // `board-ended` is only ever an answer about a session we know. Minting one
    // from the ending alone let any team member pre-block a session id: the
    // entry was created `ended`, and the real `board-live` arriving afterwards
    // found the id taken and joined a board that was already over.
    const known = this.sessions.get(k) ?? this.resolve(sessionId, conv)
    if (!known || known.host !== event.author) return // only the host ends a session
    known.ended = true
    known.endedAt = this.session.io.calibratedNow()
    this.endedLocally(sessionId, conv)
  }

  /**
   * Session info, falling back to the conversation's own log — this service is
   * built lazily on the first `boards:*` call, so a session announced before
   * that (or before a restart) is still in the events, not in the map.
   */
  private resolve(sessionId: string, conv: ConvId): BoardSessionInfo | null {
    const k = key(conv, sessionId)
    const known = this.sessions.get(k)
    if (known) return known
    // A miss is worth caching: this walks the whole conversation log, and
    // `write` asks on every frame. Nothing can turn a miss into a hit behind
    // our back — a `board-live` ingested later arrives through `onEvent`, which
    // fills the map (and clears this) before anyone asks again.
    if (this.resolveMisses.has(k)) return null
    if (!isBoardSessionId(sessionId)) return null
    let found: BoardSessionInfo | null = null
    for (const event of this.host.events.getEvents(conv)) {
      if (event.type !== 'sys' || !event.verified) continue
      const p = event.payload as SysPayload
      if (p.kind !== 'board-live' && p.kind !== 'board-ended') continue
      const data = (p.data ?? {}) as Record<string, unknown>
      if (data.sessionId !== sessionId) continue
      if (p.kind === 'board-live' && !found) {
        // Exactly the rule `onEvent` applies: the session id names its creator,
        // so an announcement by anyone else is not an announcement.
        if (!event.author.startsWith(sessionId.slice(0, 8))) continue
        found = {
          sessionId,
          conv,
          host: event.author,
          boardId: typeof data.boardId === 'string' ? data.boardId : undefined,
          title: typeof data.title === 'string' ? data.title : '',
          startedAt: typeof data.startedAt === 'number' ? data.startedAt : 0,
          ended: false,
        }
      } else if (p.kind === 'board-ended' && found && found.host === event.author) {
        // Never minted from an ending alone (see `onEvent`): without a
        // `board-live` there is no session, and no host to have ended one.
        found.ended = true
        found.endedAt = this.session.io.calibratedNow()
      }
    }
    if (found) this.sessions.set(k, found)
    else this.resolveMisses.add(k)
    return found
  }
}

/** Map key: a session id means nothing outside the conversation it was announced in. */
function key(conv: ConvId, sessionId: string): string {
  return `${conv}|${sessionId}`
}

/**
 * Bring a draft inside `BOARD.maxFrameBytes`: the newly-introduced files go
 * first (they can be re-sent, and a peer without them still renders every
 * shape), and a scene still over budget on its own fails loudly rather than
 * shipping half of itself — half a scene reconciles into a peer's canvas as
 * *deletions*.
 *
 * Reports which file ids were dropped, so the caller can offer them again on a
 * later frame instead of leaving a peer with a shape whose image never comes.
 */
export function fitFrame(draft: BoardFrameDraft): { frame: BoardFrameDraft; droppedFiles: string[] } {
  // The element cap is the sender's business too. Receivers clamp what they
  // will apply, so without this a runaway scene published happily for minutes
  // while every peer silently truncated it — the writer had no way to know.
  if ((draft.elements ?? []).length > BOARD.maxElements) throw new Error(FRAME_TOO_LARGE)
  const budget = BOARD.maxFrameBytes - FRAME_ENVELOPE_BYTES
  if (sizeOf(draft) <= budget) return { frame: draft, droppedFiles: [] }
  if (draft.files) {
    const rest: BoardFrameDraft = { elements: draft.elements }
    if (draft.pointer) rest.pointer = draft.pointer
    if (draft.selectedIds) rest.selectedIds = draft.selectedIds
    if (sizeOf(rest) <= budget) return { frame: rest, droppedFiles: Object.keys(draft.files) }
  }
  throw new Error(FRAME_TOO_LARGE)
}

function sizeOf(draft: BoardFrameDraft): number {
  return Buffer.byteLength(JSON.stringify(draft) ?? '', 'utf8')
}
