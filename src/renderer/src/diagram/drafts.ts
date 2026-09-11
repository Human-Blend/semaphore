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

/** Which unsent drawing this editor is: the copy of one message, or a new diagram. */
export function draftSlotOf(slot: Pick<DiagramEditorState, 'replyTo'>): string {
  return slot.replyTo ?? 'new'
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
