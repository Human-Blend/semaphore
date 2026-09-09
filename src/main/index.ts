import { app, BrowserWindow, dialog, shell } from 'electron'
import { basename, dirname, join } from 'node:path'
import { existsSync, renameSync, rmSync } from 'node:fs'
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

// The app used to be called Semaphore, and userData is named after the app.
// A profile from those builds holds this device's identity (and its DM key),
// so carry it over rather than greet the user as a brand-new device. Rename
// is atomic within the volume; if it can't happen, keep using the old folder.
{
  const userData = app.getPath('userData')
  const legacy = join(dirname(userData), basename(userData).replace(/^Chat/, 'Semaphore'))
  if (legacy !== userData && !existsSync(join(userData, 'lmk.sealed')) && existsSync(join(legacy, 'lmk.sealed'))) {
    try {
      rmSync(userData, { recursive: true, force: true }) // at most a Chromium cache from a launch that never set up
      renameSync(legacy, userData)
    } catch {
      app.setPath('userData', legacy)
    }
  }
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

/**
 * Path to a file shipped in `resources/`. electron-builder copies that folder
 * to the app's Resources root (`extraResources: from resources/ to .`), so a
 * packaged build reads it from `process.resourcesPath`; in dev the repo folder
 * is the source of truth. Same shape as gifProtocol's `packDir()`.
 */
function resourcePath(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, name) : join(process.cwd(), 'resources', name)
}

// ---------------------------------------------------------------------------
// Splash. Shown before controller.init() (which can spend seconds unsealing the
// keystore and walking a cold share) so the app is never a blank dock bounce.
// It is a plain frameless page — no preload, no bridge — and is NEVER assigned
// to mainWindow: the controller must not mistake it for the app window.

let splash: BrowserWindow | null = null
let splashShownAt = 0

function createSplash(): void {
  splash = new BrowserWindow({
    width: 420,
    height: 300,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    center: true,
    backgroundColor: '#0E0F13',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  splash.on('ready-to-show', () => {
    if (splash && !splash.isDestroyed()) {
      splashShownAt = Date.now()
      splash.show()
    }
  })

  // Cosmetic only — the splash carries no script of its own, so the version is
  // injected here. Any failure (window already gone, load raced the quit) is
  // swallowed: a splash without a version string is still a fine splash.
  splash.webContents.on('did-finish-load', () => {
    if (!splash || splash.isDestroyed()) return
    const label = JSON.stringify(`v${app.getVersion()}`)
    try {
      void splash.webContents
        .executeJavaScript(
          `{ const el = document.getElementById('v'); if (el) el.textContent = ${label} }`,
        )
        .catch(() => {})
    } catch {
      // ignore
    }
  })

  splash.on('closed', () => {
    splash = null
  })

  splash.loadFile(resourcePath('splash.html'))
}

function destroySplash(): void {
  if (splash && !splash.isDestroyed()) splash.destroy()
  splash = null
}

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

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    // Hold the splash for a moment so a fast boot doesn't flash it. The main
    // window is already up and focused underneath, so this is never a stall.
    const linger = Math.max(0, 1200 - (Date.now() - splashShownAt))
    setTimeout(destroySplash, linger)
  })
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
    destroySplash()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  } else if (splash && !splash.isDestroyed()) {
    // Still booting — bring the only window there is forward.
    splash.focus()
  }
})

app.whenReady().then(async () => {
  registerBlobProtocol(controller)
  registerGifProtocol()
  registerIpc(controller, () => mainWindow)
  createSplash()
  try {
    await controller.init()
  } catch (err) {
    // Rethrowing here only prints an UnhandledPromiseRejectionWarning: the
    // process stays alive with no window (window-all-closed doesn't quit on
    // darwin) while still holding the single-instance lock, so every later
    // launch exits silently. Say what happened and go down for real.
    destroySplash() // never leave a splash pinned over a failed boot
    dialog.showErrorBox('Chat could not start', err instanceof Error ? err.message : String(err))
    app.exit(1)
    return
  }
  createWindow()
  app.on('activate', () => {
    if (!mainWindow) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitting = false
app.on('before-quit', (e) => {
  destroySplash()
  if (quitting) return
  e.preventDefault()
  quitting = true
  void controller.shutdown().finally(() => app.quit())
})
