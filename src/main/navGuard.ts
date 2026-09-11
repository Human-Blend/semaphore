import { shell } from 'electron'
import type { WebContents } from 'electron'

// The navigation lock.
//
// This app never navigates: the renderer is a single page, and every link the
// user can click goes out through `setWindowOpenHandler` -> `shell.openExternal`
// because it is opened with a target. A link WITHOUT one navigates the window
// itself — and the window has the preload bridge attached, so an off-app page
// would be running inside a context that can talk to the main process.
//
// That is not hypothetical: Excalidraw's SVG export wraps any element carrying
// a `link` in a plain `<a href="…">` with no target, and the diagram tile
// inserts that markup into the page. A peer's diagram could therefore move this
// window to a URL of their choosing on a single click. The renderer strips
// those links now (`diagram/sanitize.ts`), and this is the other half: whatever
// the page tries, the window stays on the app's own document, and an http(s)
// target is handed to the OS browser exactly like a normal link.
//
// Reloads and dev-server navigations are still allowed — same protocol, same
// host, and for `file://` the same document — which is what keeps HMR working.

export function isSameDocument(target: string, current: string): boolean {
  try {
    const t = new URL(target)
    const c = new URL(current)
    if (t.protocol !== c.protocol) return false
    if (t.protocol === 'file:') return t.pathname === c.pathname
    return t.host === c.host
  } catch {
    return false
  }
}

export function lockNavigation(wc: WebContents): void {
  wc.on('will-navigate', (e, url) => {
    if (isSameDocument(url, wc.getURL())) return
    e.preventDefault()
    if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url)
  })
}
