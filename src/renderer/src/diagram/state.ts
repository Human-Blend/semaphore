// The store's diagram-editor slot. Its own module so `store/index.ts` can name
// the type without importing anything that could drag Excalidraw onto the
// startup path.

import type { ConvId } from '@shared/types'

export interface DiagramEditorState {
  /** Where a Send goes. */
  conv: ConvId
  /** 'view' opens someone else's diagram read-only (Export still works). */
  mode: 'edit' | 'view'
  /** Header title; '' means "use the default, and let the person rename it". */
  title: string
  /**
   * The .excalidraw JSON to open with: a received diagram being copied, or an
   * imported/dropped file. `null` starts blank — and then, in 'edit' mode, the
   * conversation's autosaved draft is restored if there is one.
   */
  scene: string | null
  /** Send as a reply to this event (the "Edit a copy" loop). */
  replyTo?: string
  /** Open the native file picker as soon as the editor mounts ("Import diagram…"). */
  autoImport?: boolean
  /** Load this already-in-hand file on mount (a drag-and-drop). `base64` of the raw bytes. */
  importFile?: { name: string; base64: string }
  /**
   * Live board (1.3): open straight into a session instead of a local drawing.
   * `start` hosts a new one seeded with `scene` (the tile's **Collaborate**);
   * `join` attaches to an existing one (a `board-live` sys row's **Join**).
   * Absent = the ordinary local editor, which can still start a session from
   * its header.
   */
  live?: { kind: 'start'; boardId?: string } | { kind: 'join'; sessionId: string; host?: string }
}
