import { ipcMain, powerSaveBlocker } from 'electron'
import { randomBytes } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { ConvId, RtcSignal, ScreenshareAnnounce, SysPayload } from '@shared/types'
import type { PushMessage } from '@shared/bridge'
import type { AppController } from '../appController'
import {
  listSources,
  openScreenPermissionSettings,
  primeSource,
  screenPermission,
  setupDisplayMediaHandler,
} from './capture'
import { FrameStore } from './frames'
import { SignalService } from './signal'

// Screen-share IPC slice: capture plumbing, folder signaling, frame relay,
// session announce/end via sys events in the conversation log.

export function registerScreenIpc(controller: AppController, getWindow: () => BrowserWindow | null): void {
  const push = (msg: PushMessage) => getWindow()?.webContents.send('push', msg)

  let signal: SignalService | null = null
  let frames: FrameStore | null = null
  let psbId: number | null = null

  let boundSession: unknown = null
  const services = () => {
    const chat = controller.chat
    if (!chat) throw new Error('not-ready')
    // Rebuild when the session changed (user switched team folders).
    if (boundSession !== chat.session) {
      signal?.stop()
      frames?.stop()
      signal = new SignalService(chat.session, push)
      signal.start()
      frames = new FrameStore(chat.session, push)
      boundSession = chat.session
    }
    return { chat, signal: signal!, frames: frames! }
  }

  setupDisplayMediaHandler()

  ipcMain.handle('screen:sources', () => listSources())
  ipcMain.handle('screen:permission', () => screenPermission())
  ipcMain.handle('screen:openPermissionSettings', () => openScreenPermissionSettings())
  ipcMain.handle('screen:primeSource', (_e, sourceId: string) => primeSource(sourceId))

  ipcMain.handle('screen:start', async (_e, conv: ConvId, w: number, h: number) => {
    const { chat } = services()
    const sessionId = randomBytes(8).toString('hex')
    const frameKey = randomBytes(32).toString('base64')
    const nonceBase = randomBytes(4).toString('base64')
    const announce: ScreenshareAnnounce = {
      sessionId,
      presenterDevice: chat.session.deviceId,
      frameKey,
      nonceBase,
      w,
      h,
      gen: 0,
    }
    const payload: SysPayload = {
      t: 'sys',
      conv,
      kind: 'screenshare',
      data: announce as unknown as Record<string, unknown>,
    }
    const ev = await chat.events.publish(conv, 'sys', payload)
    chat.beacon.noteOwnEvent(conv, `${ev.id}.sys.e1`)
    if (psbId === null) psbId = powerSaveBlocker.start('prevent-display-sleep')
    services().signal.setPollMode('fast')
    return { sessionId, frameKey, nonceBase }
  })

  ipcMain.handle('screen:stop', async (_e, sessionId: string, conv: ConvId) => {
    const { chat, frames } = services()
    const payload: SysPayload = { t: 'sys', conv, kind: 'screenshare-ended', data: { sessionId } }
    const ev = await chat.events.publish(conv, 'sys', payload)
    chat.beacon.noteOwnEvent(conv, `${ev.id}.sys.e1`)
    await frames.endSession(sessionId)
    if (psbId !== null) {
      powerSaveBlocker.stop(psbId)
      psbId = null
    }
    services().signal.setPollMode('idle')
  })

  ipcMain.handle('screen:join', (_e, sessionId: string) => {
    services().frames.subscribe(sessionId)
    services().signal.setPollMode('fast')
  })

  ipcMain.handle('screen:leave', (_e, sessionId: string) => {
    services().frames.unsubscribe(sessionId)
    services().signal.setPollMode('idle')
  })

  ipcMain.handle('rtc:send', (_e, sig: RtcSignal) => services().signal.send(sig))
  ipcMain.handle('rtc:setPollMode', (_e, mode: 'fast' | 'idle') => services().signal.setPollMode(mode))

  ipcMain.handle('frames:publish', (_e, sessionId: string, seq: number, bytes: Uint8Array) =>
    services().frames.publish(sessionId, seq, bytes),
  )
  ipcMain.handle('frames:watchViewers', (_e, sessionId: string, on: boolean) =>
    services().frames.watchViewers(sessionId, on),
  )
}
