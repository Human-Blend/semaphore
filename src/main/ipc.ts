import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import type { ConvId, EventPayload } from '@shared/types'
import type { PushMessage, SendDraft, SettingsView } from '@shared/bridge'
import { AppController, detectDevice } from './appController'
import { fetchLinkPreview } from './services/linkPreview'
import { registerFileIpc } from './services/filesIpc'
import { registerScreenIpc } from './services/screenIpc'

// One place registers every bridge invoke handler. Channels not yet backed by
// a service reply with a typed 'not-implemented' error the renderer can show.

export function registerIpc(controller: AppController, getWindow: () => BrowserWindow | null): void {
  const push = (msg: PushMessage) => {
    getWindow()?.webContents.send('push', msg)
  }
  controller.setPush(push)

  const chat = () => {
    const c = controller.chat
    if (!c) throw new Error('not-ready')
    return c
  }

  // App
  ipcMain.handle('app:getBoot', () => controller.getBoot())
  ipcMain.handle('app:unlock', (_e, passphrase: string) => controller.unlock(passphrase))
  ipcMain.handle('app:changeTeamFolder', () => controller.changeTeamFolder())
  ipcMain.handle('app:relaunch', () => {
    app.relaunch()
    app.exit(0)
  })
  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (url.startsWith('http:') || url.startsWith('https:')) return shell.openExternal(url)
  })
  ipcMain.handle('app:copyText', (_e, text: string) => clipboard.writeText(text))
  ipcMain.handle('app:showInFolder', (_e, path: string) => shell.showItemInFolder(path))
  ipcMain.handle('app:setBadge', (_e, count: number) => {
    if (process.platform === 'darwin') app.dock?.setBadge(count > 0 ? String(count) : '')
    else getWindow()?.setOverlayIcon(null, '') // Windows overlay handled in a later slice
  })

  // Onboarding
  ipcMain.handle('onboard:pickFolder', () => controller.pickFolder())
  ipcMain.handle('onboard:healthCheck', (_e, path: string) => controller.healthCheck(path))
  ipcMain.handle('onboard:detectDevice', () => detectDevice())
  ipcMain.handle('onboard:submit', (_e, cfg) => controller.onboardSubmit(cfg))

  // Chat
  ipcMain.handle('chat:channels', () => chat().channelViews())
  ipcMain.handle('chat:createChannel', (_e, name: string, topic?: string) => chat().createChannel(name, topic))
  ipcMain.handle('chat:dmFor', (_e, peer: string) => chat().dmFor(peer))
  ipcMain.handle('chat:events', (_e, conv: ConvId) => chat().getEvents(conv))
  ipcMain.handle('chat:send', (_e, conv: ConvId, draft: SendDraft) => chat().send(conv, draft))
  ipcMain.handle('chat:edit', (_e, conv: ConvId, target: string, text: string) =>
    chat().mutate(conv, 'edt', { t: 'edt', conv, target, body: { kind: 'text', text } } as EventPayload),
  )
  ipcMain.handle('chat:remove', (_e, conv: ConvId, target: string) =>
    chat().mutate(conv, 'del', { t: 'del', conv, target } as EventPayload),
  )
  ipcMain.handle('chat:react', (_e, conv: ConvId, target: string, emoji: string, op: 'add' | 'remove') =>
    chat().mutate(conv, 'rct', { t: 'rct', conv, target, emoji, op } as EventPayload),
  )
  ipcMain.handle('chat:pin', (_e, conv: ConvId, target: string, op: 'pin' | 'unpin') =>
    chat().mutate(conv, 'pin', { t: 'pin', conv, target, op } as EventPayload),
  )
  ipcMain.handle('chat:markRead', (_e, conv: ConvId, stem: string) => chat().markRead(conv, stem))
  ipcMain.handle('chat:setTyping', (_e, conv: ConvId | null) => chat().setTyping(conv))
  ipcMain.handle('chat:cursors', (_e, conv: ConvId) => chat().cursors(conv))

  // Presence
  ipcMain.handle('presence:list', () => chat().poller.presenceViews())
  ipcMain.handle('presence:setStatus', (_e, text: string) => chat().beacon.setPresence({ status: text }))
  ipcMain.handle('presence:setAppearState', (_e, state: 'online' | 'offline') =>
    chat().beacon.setPresence({ state }),
  )

  // Roster
  ipcMain.handle('roster:trust', (_e, deviceId: string, trust: 'trusted' | 'flagged') => {
    controller.session?.roster.setTrust(deviceId, trust)
  })

  // Links
  ipcMain.handle('links:preview', (_e, url: string) => fetchLinkPreview(url))

  // Settings
  ipcMain.handle('settings:get', () => controller.getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<SettingsView>) => controller.setSettings(patch))

  // File/blob/beam and screen-share slices register their own handlers.
  registerFileIpc(controller, getWindow)
  registerScreenIpc(controller, getWindow)
}
