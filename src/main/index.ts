import { app, BrowserWindow, dialog, powerMonitor, protocol, shell } from 'electron'
import { basename, dirname, join } from 'node:path'
import { existsSync, renameSync, rmSync } from 'node:fs'
import type { PushMessage } from '@shared/bridge'
import { AppController } from './appController'
import { registerIpc } from './ipc'
import { lockNavigation } from './navGuard'
import { IoTierManager } from './services/ioTier'
import { blobSchemePrivileges, registerBlobProtocol } from './services/blobProtocol'
import { gifSchemePrivileges, registerGifProtocol } from './services/gifProtocol'

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

// Exactly one call, before ready, carrying every custom scheme: Electron lets
// this happen once, and a second call replaces what the first registered.
protocol.registerSchemesAsPrivileged([blobSchemePrivileges, gifSchemePrivileges])

const gotLock = app.requestSingleInstanceLock({ profile: profile ?? '' })
if (!gotLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
const controller = new AppController(() => mainWindow)

// ---------------------------------------------------------------------------
// Share I/O tier (1.2). The whole read side reads its cadence from this: window
// focus, OS input idleness, and the lock/sleep signals. powerMonitor is only
// usable after `ready`, hence the try/catch in the sampler and the start()
// inside whenReady.

const ioTier = new IoTierManager({
  getSystemIdleSec: () => powerMonitor.getSystemIdleTime(),
  isWindowVisible: () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized(),
})
controller.setIoTierManager(ioTier)

function wirePowerMonitor(): void {
  // Locked or asleep: nobody is reading, and on macOS a sleeping machine's
  // SMB mount is gone anyway — polling it just piles up errors.
  powerMonitor.on('lock-screen', () => ioTier.setLocked(true))
  powerMonitor.on('unlock-screen', () => ioTier.setLocked(false))
  powerMonitor.on('suspend', () => ioTier.setSuspended(true))
  powerMonitor.on('resume', () => ioTier.setSuspended(false))
  // Not every platform emits lock-screen; these are the same signal by another
  // name on Windows and cost nothing where they never fire.
  powerMonitor.on('shutdown', () => ioTier.setSuspended(true))
  ioTier.start()
}

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

  // No bridge here, but the same rule: this window shows one local page.
  lockNavigation(splash.webContents)

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
  mainWindow.on('focus', () => ioTier.setFocused(true))
  mainWindow.on('blur', () => ioTier.setFocused(false))
  mainWindow.on('show', () => ioTier.setVisible(true))
  mainWindow.on('restore', () => ioTier.setVisible(true))
  mainWindow.on('hide', () => ioTier.setVisible(false))
  mainWindow.on('minimize', () => ioTier.setVisible(false))
  // Whole-window diagram editor (1.3): app:setFullScreen (ipc.ts) drives the
  // OS state from the renderer's toggle; these are the other direction, so
  // the editor's header reflects reality even if fullscreen is left some
  // other way (a system gesture, the traffic-light green button on macOS).
  mainWindow.on('enter-full-screen', () => {
    const msg: PushMessage = { kind: 'fullscreen', on: true }
    mainWindow?.webContents.send('push', msg)
  })
  mainWindow.on('leave-full-screen', () => {
    const msg: PushMessage = { kind: 'fullscreen', on: false }
    mainWindow?.webContents.send('push', msg)
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    ioTier.setVisible(false)
    ioTier.setFocused(false)
    // A live board is a window-shaped thing: its poller and its keepalive exist
    // to serve an open editor. With the window gone there is nobody to push
    // frames to, so stop every session and leave it — which deletes this
    // device's frame files, so peers drop us from the pointer list now instead
    // of waiting out BOARD.staleMs. On macOS the process stays alive here, so
    // without this the timers would keep writing into the session for as long
    // as the app ran in the background.
    void controller.boards?.stop()
  })

  // Any external navigation opens in the OS browser, never inside the app —
  // whether the page asks for a new window (here) or tries to move this one
  // (lockNavigation — see src/main/navGuard.ts).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })
  lockNavigation(mainWindow.webContents)

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
  wirePowerMonitor()
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
  ioTier.stop()
  if (quitting) return
  e.preventDefault()
  quitting = true
  void controller.shutdown().finally(() => app.quit())
})
