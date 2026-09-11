// What a peer's scene is allowed to contain, before anything renders it.
//
// A diagram is a JSON document written by whoever sent it, and two of its
// fields are live wires the moment a tile draws them:
//
//   * `element.link` — Excalidraw's SVG export wraps a linked shape in a plain
//     `<a href="…">` with no `target`, and the tile inserts that markup into
//     the page. A click would navigate the app window ITSELF to that URL, with
//     the preload bridge still attached. The main process now also refuses any
//     navigation away from the app (`will-navigate` in `src/main/index.ts`),
//     but the markup must not carry the link in the first place.
//   * `files[id].dataURL` — written straight into the exported SVG's
//     `<image href>`. The renderer's CSP allows `img-src https:`, and the tile
//     renders on visibility rather than on a click, so a hostile scene would
//     make every recipient fetch an attacker-chosen URL just by scrolling past
//     the message. Only `data:` survives.
//
// Plus a plain ceiling on the element count: a hand-made event inflates into
// millions of elements (see the decompressed-byte ceiling in `codec.ts`), and
// laying those out would wedge the renderer long before memory ran out.
//
// Pure — no DOM, no Excalidraw — so `render.ts` can call it before `restore()`
// and the tests can exercise it in node.

import { isDataUrl } from '@/content/parse'

/** Well above any hand-drawn diagram; a scene past this is a weapon, not a drawing. */
export const MAX_SCENE_ELEMENTS = 5000

export interface SanitizedScene {
  elements: unknown[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
}

/**
 * Clean a parsed `.excalidraw` document.
 *
 * `stripLinks` is on for the render path (the tile, and every export made from
 * it), where a link becomes real markup in this window. It stays OFF for the
 * editor: there a link is Excalidraw's own feature, the person is looking at a
 * canvas rather than at injected HTML, and a click goes out through
 * `setWindowOpenHandler` → `shell.openExternal` like any other message link.
 *
 * Throws on an oversized scene; every caller already shows "this diagram could
 * not be drawn" when the load throws.
 */
export function sanitizeScene(raw: unknown, opts: { stripLinks?: boolean } = {}): SanitizedScene {
  const doc = (raw && typeof raw === 'object' ? raw : {}) as {
    elements?: unknown
    appState?: unknown
    files?: unknown
  }
  const elements = Array.isArray(doc.elements) ? doc.elements : []
  if (elements.length > MAX_SCENE_ELEMENTS) {
    throw new Error(`diagram-scene: too many elements (${elements.length} > ${MAX_SCENE_ELEMENTS})`)
  }
  return {
    elements: opts.stripLinks ? elements.map(withoutLink) : elements,
    appState: doc.appState && typeof doc.appState === 'object' ? (doc.appState as Record<string, unknown>) : {},
    files: sanitizeSceneFiles(doc.files),
  }
}

/** `link: null` is Excalidraw's own "no link" value, so `restore()` sees nothing unusual. */
function withoutLink(el: unknown): unknown {
  if (!el || typeof el !== 'object') return el
  if ((el as { link?: unknown }).link == null) return el
  return { ...(el as Record<string, unknown>), link: null }
}

/**
 * Keep only embedded images. A URL's scheme is read the way a browser reads it
 * — leading C0 controls and spaces are ignored — so a padded `" https://…"`
 * is rejected along with the plain form.
 */
export function sanitizeSceneFiles(files: unknown): Record<string, unknown> {
  if (!files || typeof files !== 'object') return {}
  const out: Record<string, unknown> = {}
  for (const [id, f] of Object.entries(files as Record<string, unknown>)) {
    if (isDataUrl((f as { dataURL?: unknown } | null)?.dataURL)) out[id] = f
  }
  return out
}
