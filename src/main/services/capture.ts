import { desktopCapturer, screen, session as electronSession, shell, systemPreferences } from 'electron'
import type { ScreenSourceView } from '@shared/bridge'
import { RTC } from '@shared/constants'

// Screen capture plumbing: source enumeration (main-process-only since
// Electron 17), the display-media request handler, and the macOS Screen
// Recording permission dance.
//
// 1.2: dropped the macOS 15+ native system picker path (`useSystemPicker` /
// `usesSystemPicker()`). It defaulted to windows, gave no in-app cue about
// what was actually selected, and combined with the pre-1.2 custom picker
// starting with nothing selected, both produced the same user-visible bug:
// "screen share only shares the Chat window". One path now, everywhere —
// Chat's own picker, screens first, primary display pre-selected. See
// `docs/features-1.2.md` / CLAUDE.md "Screen share picker (1.2)".

let primedSourceId: string | null = null

export function setupDisplayMediaHandler(): void {
  electronSession.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
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
  })
}

export function primeSource(sourceId: string): void {
  primedSourceId = sourceId
}

interface CapturerSourceLike {
  id: string
  kind: 'screen' | 'window'
  displayId: string
}

/**
 * Screens first, primary display first among them, windows after. Pure (no
 * electron import) so it's directly testable: source ordering is the one
 * piece of this file that's worth unit-testing on its own.
 *
 * `displayId` is `DesktopCapturerSource.display_id`, matched against
 * `screen.getPrimaryDisplay().id`; it can come back empty (permission not
 * yet settled, or a platform that doesn't populate it) — when that leaves no
 * match and there's exactly one screen, that lone screen is still the only
 * sane "primary" and gets flagged so the picker can pre-select it.
 */
export function orderSources<T extends CapturerSourceLike>(
  sources: readonly T[],
  primaryDisplayId: string,
): (T & { primary?: true })[] {
  const screens = sources.filter((s) => s.kind === 'screen')
  const windows = sources.filter((s) => s.kind === 'window')
  let primaryId = screens.find((s) => s.displayId === primaryDisplayId)?.id ?? null
  if (!primaryId && screens.length === 1) primaryId = screens[0].id
  const ordered = primaryId ? [...screens].sort((a, b) => Number(b.id === primaryId) - Number(a.id === primaryId)) : screens
  return [
    ...ordered.map((s) => (s.id === primaryId ? { ...s, primary: true as const } : s)),
    ...windows,
  ]
}

export async function listSources(): Promise<{ sources: ScreenSourceView[]; systemPicker: boolean }> {
  let sources: Electron.DesktopCapturerSource[]
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: true,
    })
  } catch {
    // Observed on this Mac (macOS 15+, ad-hoc-signed build): without the
    // Screen Recording grant, getSources() doesn't hand back fake/wallpaper
    // thumbnails the way older macOS did — it rejects outright ("Failed to
    // get sources."). Either way this enumeration attempt is what registers
    // Chat with TCC; an empty list here still drives the caller straight to
    // the post-attempt screenPermission() check and the explainer panel,
    // same as a genuinely empty (but non-throwing) result.
    return { systemPicker: false, sources: [] }
  }
  const raw = sources.map((s) => ({
    id: s.id,
    kind: s.id.startsWith('screen') ? ('screen' as const) : ('window' as const),
    displayId: s.display_id,
  }))
  const primaryDisplayId = String(screen.getPrimaryDisplay().id)
  const ordered = orderSources(raw, primaryDisplayId)
  const byId = new Map(sources.map((s) => [s.id, s]))
  return {
    systemPicker: false,
    sources: ordered.map((o): ScreenSourceView => {
      const s = byId.get(o.id)!
      return {
        id: s.id,
        name: s.name,
        kind: o.kind,
        thumbnailDataUrl: s.thumbnail.toDataURL(),
        appIconDataUrl: s.appIcon?.toDataURL(),
        ...(o.primary ? { primary: true as const } : {}),
      }
    }),
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
