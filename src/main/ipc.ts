import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import type { ConvId, EventPayload } from '@shared/types'
import type { PushMessage, SendDraft, SettingsView, ShareStats } from '@shared/bridge'
import { DIR } from '@shared/constants'
import { redactEventForRenderer, redactPushForRenderer } from '@shared/prs'
import { AppController, detectDevice } from './appController'
import { fetchLinkPreview } from './services/linkPreview'
import { registerBoardsIpc } from './services/boardsIpc'
import { registerCalendarIpc } from './services/calendarIpc'
import { registerFileIpc } from './services/filesIpc'
import { registerPrsIpc } from './services/prsIpc'
import { registerScreenIpc } from './services/screenIpc'

// One place registers every bridge invoke handler. Channels not yet backed by
// a service reply with a typed 'not-implemented' error the renderer can show.

export function registerIpc(controller: AppController, getWindow: () => BrowserWindow | null): void {
  const push = (msg: PushMessage) => {
    // The `prs` config event carries the team's shared Azure DevOps PAT in
    // cleartext. The renderer never reads it (the pane goes by
    // `PrsStatus.sharedTokenSet`), so it is stripped here rather than copied
    // into sandboxed web memory — same treatment as the `chat:events` reply.
    getWindow()?.webContents.send('push', redactPushForRenderer(msg))
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
  ipcMain.handle('app:resetLocalData', () => controller.resetLocalData())
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
  ipcMain.handle('chat:events', (_e, conv: ConvId) => chat().getEvents(conv).map(redactEventForRenderer))
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
  ipcMain.handle('chat:myReads', () => chat().myReads())

  // Channel management (1.2): both publish a sys event into the channel's own
  // log — the metadata file is never rewritten (clients cache it once).
  ipcMain.handle('chat:renameChannel', (_e, conv: ConvId, name: string) => chat().renameChannel(conv, name))
  ipcMain.handle('chat:deleteChannel', (_e, conv: ConvId) => chat().deleteChannel(conv))

  // 1.3: every stub registered here has been replaced by its owning service,
  // so there is no `not-implemented` fallback left to hand the renderer.
  // Polls (1.3). Both re-validate everything the renderer checked: the option
  // ids against the poll, `multi`, whether it is closed, and — for the close —
  // that the caller is the poll's own author.
  ipcMain.handle('chat:vote', (_e, conv: ConvId, target: string, choice: string[]) =>
    chat().vote(conv, target, choice),
  )
  ipcMain.handle('chat:closePoll', (_e, conv: ConvId, target: string) => chat().closePoll(conv, target))
  // boards:start/join/write/leave/end are live — registerBoardsIpc below.
  // Whole-window diagram editor (1.3): a real OS fullscreen toggle. The
  // enter-full-screen/leave-full-screen listeners that push the resulting
  // state back to the renderer are wired in main/index.ts, next to the
  // window's other focus/blur/show wiring.
  ipcMain.handle('app:setFullScreen', (_e, on: boolean) => {
    getWindow()?.setFullScreen(on)
  })
  ipcMain.handle('app:isFullScreen', () => getWindow()?.isFullScreen() ?? false)

  // Private groups (1.2). Reading is the ordinary event path; these are the
  // membership/key operations.
  ipcMain.handle('groups:list', () => chat().groups.views())
  ipcMain.handle('groups:create', (_e, name: string, members: string[]) => chat().groups.create(name, members))
  ipcMain.handle('groups:rename', (_e, conv: ConvId, name: string) => chat().groups.rename(conv, name))
  ipcMain.handle('groups:addMembers', (_e, conv: ConvId, members: string[]) =>
    chat().groups.addMembers(conv, members),
  )
  ipcMain.handle('groups:removeMember', (_e, conv: ConvId, member: string) =>
    chat().groups.removeMember(conv, member),
  )
  ipcMain.handle('groups:leave', (_e, conv: ConvId) => chat().groups.leave(conv))
  ipcMain.handle('groups:remove', (_e, conv: ConvId) => chat().groups.remove(conv))
  // files:pickFile / saveBytesAs / stageBytes are live — registerFileIpc below.

  // Peer-announced updates (1.2): the banner's action when the signed manifest
  // isn't there yet. Creating the folder first means the button always lands
  // somewhere real rather than in an OS "no such directory" beep.
  ipcMain.handle('app:openAppsFolder', async () => {
    const io = controller.session?.io
    if (!io) throw new Error('not-ready')
    await io.ensureDir(DIR.apps).catch(() => {})
    await shell.openPath(io.abs(DIR.apps))
  })

  // Live share traffic (1.2) — Settings' "Share traffic" line.
  ipcMain.handle('diag:shareStats', (): ShareStats => {
    const io = controller.session?.io
    if (!io) throw new Error('not-ready')
    return { ...io.stats(), tier: controller.chat?.ioTier ?? controller.ioTier?.tier ?? 'blurred' }
  })

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

  // File/blob/beam, screen-share and team-log slices register their own handlers.
  registerFileIpc(controller, getWindow)
  registerScreenIpc(controller, getWindow)
  registerBoardsIpc(controller, getWindow)
  registerCalendarIpc(controller, getWindow)
  registerPrsIpc(controller, getWindow)
}
