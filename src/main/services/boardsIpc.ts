import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { BoardFrameDraft, ConvId } from '@shared/types'
import type { PushMessage } from '@shared/bridge'
import type { AppController } from '../appController'
import { assertBoardSessionId, BoardService } from './boards'

// Live-board IPC slice (1.3). Built exactly like the screen-share slice: one
// lazily-created service bound to the current Session, rebuilt when the user
// switches team folders (a board is meaningless across that boundary, and the
// old service's timers must not keep polling a share we left).
//
// The service it builds is handed to `controller.boards`, which is what stops
// it: `changeTeamFolder`, `shutdown` and the main window's `closed` all go
// through the controller, and none of them can reach into this closure.
//
// Every handler that takes a session id validates its shape before the service
// sees it. The id is a path segment on the share, and `..` in it used to walk
// `boards/<sessionId>/…` straight out of the share root.

export function registerBoardsIpc(controller: AppController, getWindow: () => BrowserWindow | null): void {
  const push = (msg: PushMessage) => getWindow()?.webContents.send('push', msg)

  let boards: BoardService | null = null
  let boundSession: unknown = null
  const service = (): BoardService => {
    const chat = controller.chat
    if (!chat) throw new Error('not-ready')
    if (boundSession !== chat.session) {
      void boards?.stop()
      boards = new BoardService(
        chat.session,
        {
          events: chat.events,
          noteOwnEvent: (conv, fileName) => chat.noteOwnEvent(conv, fileName),
          // The frame poller follows the same I/O tier as everything else:
          // focused 1 s, blurred 3 s, and not a single readdir while paused.
          tier: () => chat.ioTier,
        },
        push,
      )
      boundSession = chat.session
      controller.boards = boards
    }
    return boards!
  }

  ipcMain.handle('boards:start', (_e, conv: ConvId, title: string, boardId?: string) =>
    service().start(conv, title, boardId),
  )
  ipcMain.handle('boards:join', (_e, sessionId: string, conv: ConvId) =>
    service().join(assertBoardSessionId(sessionId), conv),
  )
  ipcMain.handle('boards:write', (_e, sessionId: string, conv: ConvId, draft: BoardFrameDraft) =>
    service().write(assertBoardSessionId(sessionId), conv, draft),
  )
  ipcMain.handle('boards:leave', (_e, sessionId: string, conv: ConvId) =>
    service().leave(assertBoardSessionId(sessionId), conv),
  )
  ipcMain.handle('boards:end', (_e, sessionId: string, conv: ConvId, resultStem?: string) =>
    service().end(assertBoardSessionId(sessionId), conv, resultStem),
  )
}
