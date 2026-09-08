import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { AppController } from './appController'
import { registerIpc } from './ipc'
import { registerBlobProtocol, registerBlobScheme } from './services/blobProtocol'
import { registerGifProtocol, registerGifScheme } from './services/gifProtocol'

// mDNS candidate obfuscation would replace host-candidate IPs with .local names
// that corporate LANs can't resolve, killing every P2P connection. Must be set
// before app ready. If more features are ever disabled, comma-join them here —
// repeated appendSwitch('disable-features', ...) calls overwrite each other.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns')

// Dev convenience: SEMAPHORE_PROFILE=alice|bob gives each instance its own
// userData so two clients can run side-by-side against one local "share".
const profile = process.env.SEMAPHORE_PROFILE
if (profile && !app.isPackaged) {
  app.setPath('userData', `${app.getPath('userData')}-${profile}`)
}

// Windows toast plumbing keys off the AppUserModelID; must match appId in
// electron-builder.yml and be set before any notification.
app.setAppUserModelId('com.semaphore.teamchat')

registerBlobScheme()
registerGifScheme()

const gotLock = app.requestSingleInstanceLock({ profile: profile ?? '' })
if (!gotLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
const controller = new AppController(() => mainWindow)

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0E0F13',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 11 } }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: '#14151B', symbolColor: '#A9ADBB', height: 44 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.webContents.setWebRTCIPHandlingPolicy('default')

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('focus', () => controller.chat?.focusPollRate(true))
  mainWindow.on('blur', () => controller.chat?.focusPollRate(false))
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Any external navigation opens in the OS browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  registerBlobProtocol(controller)
  registerGifProtocol()
  registerIpc(controller, () => mainWindow)
  await controller.init()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  e.preventDefault()
  quitting = true
  void controller.shutdown().finally(() => app.quit())
})
