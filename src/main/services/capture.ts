import { desktopCapturer, session as electronSession, shell, systemPreferences } from 'electron'
import type { ScreenSourceView } from '@shared/bridge'
import { RTC } from '@shared/constants'

// Screen capture plumbing: source enumeration (main-process-only since
// Electron 17), the display-media request handler, and the macOS Screen
// Recording permission dance. On macOS 15+ the native system picker handles
// source choice AND sidesteps the TCC prompt — our custom picker is the
// fallback for older macOS and Windows.

let primedSourceId: string | null = null

export function setupDisplayMediaHandler(): void {
  electronSession.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      if (!primedSourceId) {
        callback({})
        return
      }
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
        const src = sources.find((s) => s.id === primedSourceId)
        callback(src ? { video: src } : {})
      } catch {
        callback({})
      } finally {
        primedSourceId = null
      }
    },
    { useSystemPicker: true },
  )
}

export function primeSource(sourceId: string): void {
  primedSourceId = sourceId
}

export function usesSystemPicker(): boolean {
  // The system picker exists on macOS 15+; Electron falls back to the handler
  // elsewhere. Sequoia is Darwin 24.x.
  if (process.platform !== 'darwin') return false
  const major = Number(process.getSystemVersion()?.split('.')[0] ?? 0)
  return major >= 15
}

export async function listSources(): Promise<{ sources: ScreenSourceView[]; systemPicker: boolean }> {
  if (usesSystemPicker()) return { sources: [], systemPicker: true }
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: true,
  })
  return {
    systemPicker: false,
    sources: sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen') ? ('screen' as const) : ('window' as const),
      thumbnailDataUrl: s.thumbnail.toDataURL(),
      appIconDataUrl: s.appIcon?.toDataURL(),
    })),
  }
}

export function screenPermission(): 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown' {
  if (process.platform !== 'darwin') return 'granted'
  try {
    return systemPreferences.getMediaAccessStatus('screen')
  } catch {
    return 'unknown'
  }
}

export async function openScreenPermissionSettings(): Promise<void> {
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
}

export const CAPTURE_CONSTRAINTS = {
  maxWidth: RTC.captureMaxWidth,
  maxHeight: RTC.captureMaxHeight,
  maxFps: RTC.captureMaxFps,
}
