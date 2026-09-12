import { app, dialog, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { PushMessage } from '@shared/bridge'
import type { AppController } from '../appController'
import { BlobService, mimeForName, sanitizeFileName } from './blobs'
import type { ChatService } from './chatService'
import { DropService } from './drops'
import { discardStaged, isStagedPath, stagingRoot, sweepStaging } from './staging'

// File/blob/beam IPC slice. Services can only exist once a session is live
// (controller.chat is null until then), and chat.send() consults the
// attachment uploader directly — so wiring happens the moment chat appears,
// not merely on the first files:* invoke. Re-onboarding replaces the
// ChatService instance; the same hook re-wires against the new one.
//
// The wiring is driven by controller.onSessionChange (synchronous, inside
// startSession — so BlobService.initProtocol() has run before the renderer can
// be told the app is ready) with the old 1 s poll kept behind it as a backstop
// for any session that ever appears without firing the hook.

interface FileServices {
  blobs: BlobService
  drops: DropService
}

export function registerFileIpc(controller: AppController, getWindow: () => BrowserWindow | null): void {
  let wiredChat: ChatService | null = null
  let services: FileServices | null = null
  let unsubTier: (() => void) | null = null

  const push = (msg: PushMessage): void => {
    getWindow()?.webContents.send('push', msg satisfies PushMessage)
  }

  /** Drop the previous session's services. Idempotent; safe with none wired. */
  const unwire = (): void => {
    services?.drops.stop()
    unsubTier?.()
    unsubTier = null
    services = null
    wiredChat = null
  }

  const wire = (): FileServices | null => {
    const chat = controller.chat
    // changeTeamFolder (and a lock) nulls controller.chat before any new
    // ChatService exists. Tearing down only when a *replacement* appears left
    // the old drops poller scanning the old share's inbox and the old tier
    // subscription alive — a leak per re-onboarding, and share traffic against
    // a folder the user has left.
    if (!chat) {
      if (wiredChat) unwire()
      return null
    }
    if (chat !== wiredChat) {
      unwire()
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
      // The inbox scan follows the share-I/O tier (1.2): 30 s awake, 5 min
      // idle, nothing while the machine is locked or asleep. A beacon drop
      // hint still scans immediately, so a slow tier never delays a beam.
      unsubTier = controller.ioTier?.onChange((tier) => drops.setTier(tier)) ?? null
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
  // Synchronous with the session starting/stopping; the poll is the backstop.
  controller.onSessionChange(() => {
    wire()
  })
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

  registerLocalFileIpc(getWindow)
}

// ---------------------------------------------------------------------------
// Local-file IPC (1.2) — the diagram editor's import/export/stage paths.
//
// The renderer is sandboxed web code with no filesystem of its own, so opening
// a `.excalidraw` file, saving a PNG/SVG export, and handing an oversized scene
// to the blob uploader all have to cross the bridge as base64. Everything here
// is main-side: the dialogs, the read/write, and the size ceilings.

/** Anything larger is a mistake rather than a diagram; refuse it before it crosses IPC. */
const PICK_MAX_BYTES = 32 * 1024 * 1024

// Staged scenes live under userData, not the share. They are deleted by the
// uploader the moment it has consumed one (`discardStaged`, called from
// BlobService.uploadOne) and swept on launch as a backstop — see staging.ts.
export { discardStaged, isStagedPath, stagingRoot, sweepStaging }

export function registerLocalFileIpc(getWindow: () => BrowserWindow | null): void {
  void sweepStaging()

  // Native open dialog; the bytes come back base64 so the renderer never needs
  // a path it couldn't read anyway.
  ipcMain.handle(
    'files:pickFile',
    async (_e, opts: { title?: string; filters: { name: string; extensions: string[] }[] }) => {
      const win = getWindow()
      const res = await (win
        ? dialog.showOpenDialog(win, {
            title: opts?.title,
            filters: opts?.filters ?? [],
            properties: ['openFile'],
          })
        : dialog.showOpenDialog({ title: opts?.title, filters: opts?.filters ?? [], properties: ['openFile'] }))
      const path = res.canceled ? undefined : res.filePaths[0]
      if (!path) return null
      const st = await stat(path)
      if (st.size > PICK_MAX_BYTES) throw new Error('file-too-large')
      const buf = await readFile(path)
      return { path, name: basename(path), bytes: buf.toString('base64') }
    },
  )

  // Native save dialog for renderer-produced bytes (a PNG/SVG/.excalidraw export).
  ipcMain.handle('files:saveBytesAs', async (_e, suggestedName: string, bytes: string, mime?: string) => {
    const win = getWindow()
    const name = sanitizeFileName(suggestedName || 'export')
    const ext = extname(name).slice(1).toLowerCase()
    const opts = {
      defaultPath: join(app.getPath('downloads'), name),
      filters: ext ? [{ name: (mime ?? mimeForName(name)).split('/').pop() ?? ext, extensions: [ext] }] : [],
    }
    const res = await (win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts))
    if (res.canceled || !res.filePath) return null
    await writeFile(res.filePath, Buffer.from(bytes, 'base64'))
    return res.filePath
  })

  // Park renderer bytes on local disk so they can ride the ordinary attachment
  // path (`AttachDraft.path` → BlobService.upload, which only stats + streams
  // the file). One directory per call, so the uploaded blob keeps the caller's
  // file name verbatim.
  ipcMain.handle('files:stageBytes', async (_e, name: string, bytes: string) => {
    // Same 32 MB ceiling as pickFile, checked against the base64 length first:
    // decoding a hostile-sized string only to measure it is the allocation the
    // ceiling exists to prevent (4 base64 chars carry 3 bytes).
    if (typeof bytes !== 'string' || bytes.length > Math.ceil((PICK_MAX_BYTES * 4) / 3) + 4) {
      throw new Error('file-too-large')
    }
    const buf = Buffer.from(bytes, 'base64')
    if (buf.length > PICK_MAX_BYTES) throw new Error('file-too-large')
    const dir = join(stagingRoot(), randomBytes(6).toString('hex'))
    await mkdir(dir, { recursive: true })
    const path = join(dir, sanitizeFileName(name || 'diagram'))
    await writeFile(path, buf)
    return { path }
  })
}
