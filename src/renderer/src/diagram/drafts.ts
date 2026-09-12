// Per-editor-slot diagram drafts.
//
// Closing the editor with unsaved work must not throw the work away: a drawing
// is minutes of effort, not a half-typed sentence. The draft is renderer-local
// (localStorage), restored when the editor reopens on the same slot, and
// cleared the moment the diagram is sent.
//
// A *slot*, not a conversation: "new diagram in #design" and "edit a copy of
// Ana's diagram in #design" are two different pieces of unsent work that used
// to share one key, so opening the second one silently overwrote the first —
// and the first was never coming back. The key is therefore the conversation
// plus the message being replied to ('new' when there isn't one).
//
// Deliberately not on the share: an unsent draft is nobody else's business,
// and writing it there would cost share I/O on every keystroke.

import type { DiagramEditorState } from './state'

const PREFIX = 'chat.diagram.draft.'
/** Well inside a 5 MB localStorage quota, and far above any hand-drawn scene. */
const MAX_DRAFT_CHARS = 1_500_000

export interface DiagramDraft {
  title: string
  /** The .excalidraw JSON document, exactly as `serializeAsJSON` produced it. */
  scene: string
  savedAt: number
}

/**
 * Which unsent drawing this editor is: a live board, the copy of one message,
 * or a new diagram.
 *
 * A live board must never share the conversation's `new` slot (1.3). That slot
 * holds the private drawing the person has not sent yet, and a live editor
 * writing into it — or reading out of it — is four bugs at once: joining a
 * board publishes your unsent diagram to everyone, Collaborate opens the wrong
 * scene, a peer's strokes overwrite your draft, and closing a board you only
 * watched asks about "unsaved work" that was never yours. So a join is keyed by
 * its session (one slot per board) and a start by `live:new`.
 */
export function draftSlotOf(slot: Pick<DiagramEditorState, 'replyTo' | 'live'>): string {
  if (slot.live?.kind === 'join') return `${LIVE_PREFIX}${slot.live.sessionId}`
  if (slot.live?.kind === 'start') return `${LIVE_PREFIX}new`
  return slot.replyTo ?? 'new'
}

const LIVE_PREFIX = 'live:'

/**
 * Whether this slot's opening scene may come out of localStorage.
 *
 * Never for a live board: a join's scene is whatever the session's frames say
 * (restoring one would republish a stale copy at everybody), and a start's is
 * the diagram it was seeded from — a leftover `live:new` draft from the *last*
 * board would otherwise open in place of the one that was clicked. The draft is
 * still written (an autosave costs nothing and a crash mid-session is not the
 * moment to find out it wasn't), but nothing reopens it, which is what the
 * editor's close dialog has to say instead of promising it comes back.
 */
export function draftRestorable(slot: Pick<DiagramEditorState, 'replyTo' | 'live'>): boolean {
  return !slot.live
}

/**
 * Drop every *other* live draft for this conversation.
 *
 * A session id is new every time, so `live:<sessionId>` keys would accumulate
 * one oversized scene per board this device ever joined and eventually fill the
 * quota — at which point the close dialog stops being able to promise anything
 * about real work. Called on each live save: one live draft per conversation at
 * a time, and it is the open one.
 */
export function pruneLiveDrafts(conv: string, keepSlot: string): void {
  try {
    const keep = keyFor(conv, keepSlot)
    const prefix = keyFor(conv, LIVE_PREFIX)
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k !== keep && k.startsWith(prefix)) doomed.push(k)
    }
    for (const k of doomed) localStorage.removeItem(k)
  } catch {
    /* nothing to prune */
  }
}

function keyFor(conv: string, slot: string): string {
  return `${PREFIX}${conv}|${slot}`
}

export function readDraft(conv: string, slot: string): DiagramDraft | null {
  try {
    const raw = localStorage.getItem(keyFor(conv, slot))
    if (!raw) return null
    const d = JSON.parse(raw) as Partial<DiagramDraft>
    if (typeof d?.scene !== 'string' || !d.scene) return null
    return { title: typeof d.title === 'string' ? d.title : '', scene: d.scene, savedAt: d.savedAt ?? 0 }
  } catch {
    return null
  }
}

/**
 * Save, and say whether it happened. The caller's close dialog promises the
 * work is kept, so it has to know when that promise can't be made: an
 * oversized scene, a full quota, a private-mode window.
 */
export function writeDraft(conv: string, slot: string, draft: Omit<DiagramDraft, 'savedAt'>): boolean {
  if (draft.scene.length > MAX_DRAFT_CHARS) return false
  try {
    localStorage.setItem(keyFor(conv, slot), JSON.stringify({ ...draft, savedAt: Date.now() } satisfies DiagramDraft))
    // A live slot is per session: keep the quota from filling up with the
    // scenes of boards that ended (see pruneLiveDrafts).
    if (slot.startsWith(LIVE_PREFIX)) pruneLiveDrafts(conv, slot)
    return true
  } catch {
    // Quota or private mode. Not an error worth interrupting a drawing for —
    // but `false` travels up to the close dialog, which stops claiming the
    // work was kept.
    return false
  }
}

export function clearDraft(conv: string, slot: string): void {
  try {
    localStorage.removeItem(keyFor(conv, slot))
  } catch {
    /* nothing to clear */
  }
}
