// Pure key-combo -> action mapping for the diagram editor's OS-fullscreen
// toggle (1.3, plan §D). Extracted out of DiagramEditor's capture-phase
// keydown handler so it can be unit-tested without mounting Excalidraw
// (vitest here is node-only — see CLAUDE.md).
//
// F11 toggles fullscreen on Windows/Linux; macOS reserves F11 for "Show
// Desktop" system-wide, so the editor listens for ⌃⌘F (Control+Command+F)
// there instead — same chord Finder and Mail use for their own fullscreen.

export interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export type Platform = 'darwin' | 'win32' | 'linux'

/** The tooltip/label for the toggle button, per platform. */
export function fullScreenKeyLabel(platform: Platform): string {
  return platform === 'darwin' ? '⌃⌘F' : 'F11'
}

/**
 * True when `e` is this editor's fullscreen-toggle chord for `platform`.
 * Shift or Alt held rules it out, so a chord that happens to share F11/F key
 * with something else (e.g. a future ⌃⌘⇧F) is never misread as this one.
 */
export function isFullScreenToggleKey(e: KeyLike, platform: Platform): boolean {
  if (e.shiftKey || e.altKey) return false
  if (platform === 'darwin') return e.ctrlKey && e.metaKey && e.key.toLowerCase() === 'f'
  return e.key === 'F11' && !e.ctrlKey && !e.metaKey
}
