// The two ways into a live board from outside the editor: a `board-live` sys
// row's **Join** and a diagram tile's **Collaborate**.
//
// Both of them only fill the editor slot — DiagramRoot's `lazy()` is what
// actually loads Excalidraw. That is the whole reason this is a separate,
// four-import module: `MessageList` and `DiagramTile` are on the startup path,
// and neither may reach the 1 MB chunk just to render a button.

import type { ConvId } from '@shared/types'
import { useStore } from '@/store'
import type { LiveBoardEntry } from './live'

/** Join an announced session; the editor opens empty and fills from the frames. */
export function openLiveBoard(entry: LiveBoardEntry): void {
  useStore.getState().openDiagramEditor({
    conv: entry.conv,
    mode: 'edit',
    title: entry.title,
    scene: null,
    live: { kind: 'join', sessionId: entry.sessionId, host: entry.host },
  })
}

/** Host a new session seeded with a diagram that is already in the conversation. */
export function collaborateOn(opts: { conv: ConvId; title: string; scene: string; boardId: string }): void {
  useStore.getState().openDiagramEditor({
    conv: opts.conv,
    mode: 'edit',
    title: opts.title,
    scene: opts.scene,
    live: { kind: 'start', boardId: opts.boardId },
  })
}
