import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PushMessage } from '@shared/bridge'
import type { AppController } from '../appController'
import { BlobService } from './blobs'
import type { ChatService } from './chatService'
import { DropService } from './drops'

// File/blob/beam IPC slice. Services can only exist once a session is live
// (controller.chat is null until then), and chat.send() consults the
// attachment uploader directly — so wiring happens the moment chat appears
// (cheap 1s poll), not merely on the first files:* invoke. Re-onboarding
// replaces the ChatService instance; the poll re-wires against the new one.

interface FileServices {
  blobs: BlobService
  drops: DropService
}

export function registerFileIpc(controller: AppController, getWindow: () => BrowserWindow | null): void {
  let wiredChat: ChatService | null = null
  let services: FileServices | null = null

  const push = (msg: PushMessage): void => {
    getWindow()?.webContents.send('push', msg satisfies PushMessage)
  }

  const wire = (): FileServices | null => {
    const chat = controller.chat
    if (!chat) return null
    if (chat !== wiredChat) {
      services?.drops.stop()
      wiredChat = chat
      const blobs = new BlobService(chat, getWindow, push)
      blobs.initProtocol()
      const drops = new DropService(chat, getWindow, push, () => controller.getSettings())
      chat.attachmentUploader = (items, conv) => blobs.upload(items, conv)
      chat.dropHintHandler = () => drops.noteHint()
      // Peers' blob-upload progress (their beacon xfers): no renderer surface
      // consumes it in v1 — the downloader's own 'blob' pushes carry progress.
      chat.xferHandler = () => {}
      drops.start()
      services = { blobs, drops }
    }
    return services
  }

  const ensure = (): FileServices => {
    const s = wire()
    if (!s) throw new Error('not-ready')
    return s
  }

  wire()
  setInterval(wire, 1000)

  // Blobs
  ipcMain.handle('files:fetchBlob', (_e, blobId: string, key: string, name: string, size: number) =>
    ensure().blobs.fetchBlob(blobId, key, name, size),
  )
  ipcMain.handle('files:saveBlobAs', (_e, blobId: string, suggestedName: string) =>
    ensure().blobs.saveBlobAs(blobId, suggestedName),
  )
  ipcMain.handle('files:startDrag', (_e, blobId: string, name: string) => ensure().blobs.startDrag(blobId, name))

  // Beams
  ipcMain.handle('beams:send', (_e, peerDeviceId: string, filePaths: string[]) =>
    ensure().drops.send(peerDeviceId, filePaths),
  )
  ipcMain.handle('beams:accept', (_e, dropId: string, savePath?: string) => ensure().drops.accept(dropId, savePath))
  ipcMain.handle('beams:decline', (_e, dropId: string) => ensure().drops.decline(dropId))
  ipcMain.handle('beams:cancel', (_e, dropId: string) => ensure().drops.cancel(dropId))

  // Updates: copy the newest zip locally + verify sha256 + reveal
  ipcMain.handle('update:copyToMachine', () => {
    const updates = controller.updates
    if (!updates) throw new Error('not-ready')
    return updates.copyToMachine()
  })

  // GIFs — bundled starter pack only (zero network by design)
  ipcMain.handle('gifs:packList', async () => {
    try {
      const base = app.isPackaged
        ? join(process.resourcesPath, 'gifs-starter')
        : join(process.cwd(), 'resources', 'gifs-starter')
      const raw = await readFile(join(base, 'manifest.json'), 'utf8')
      const list = JSON.parse(raw) as unknown
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  })
  ipcMain.handle('gifs:search', () => ({ online: false, results: [] as { url: string; w: number; h: number }[] }))
}
