// The lazy half of the tile: turning a scene into a crisp SVG, and into the
// PNG/SVG/.excalidraw files the Export menu writes.
//
// Importing this module pulls in @excalidraw/excalidraw (~1 MB), so nothing on
// the chat startup path may import it statically — DiagramTile reaches it
// through `await import('./render')` when a tile actually scrolls into view,
// and the editor shares the same chunk.

// MUST come first: it arms window.EXCALIDRAW_ASSET_PATH before Excalidraw's
// font registry reads it. See assets.ts.
import './assets'
import { exportToBlob, exportToSvg, restore } from '@excalidraw/excalidraw'
import type { ExcalidrawElement, NonDeleted } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types'
import { sanitizeScene } from './sanitize'
import { SvgCache } from './svgCache'

export interface LoadedScene {
  elements: NonDeleted<ExcalidrawElement>[]
  appState: Partial<AppState>
  files: BinaryFiles
}

/**
 * Parse + repair an .excalidraw document into something renderable.
 *
 * Everything that reaches here came off the share, so it goes through
 * `sanitizeScene` first: element links are dropped (Excalidraw's SVG export
 * turns one into a bare `<a href>` that would navigate this very window), any
 * `files[]` entry whose `dataURL` is not a `data:` URI is dropped (it would
 * become a remote `<image href>` the tile fetches on visibility), and an
 * absurd element count is refused outright. Throws on the last of those — the
 * tile renders `phase:'failed'`.
 */
export function loadScene(json: string): LoadedScene {
  const raw = sanitizeScene(JSON.parse(json), { stripLinks: true })
  const restored = restore({ elements: raw.elements as never, appState: raw.appState as never, files: raw.files as never }, null, null)
  return {
    elements: restored.elements as NonDeleted<ExcalidrawElement>[],
    appState: restored.appState,
    files: restored.files ?? {},
  }
}

/**
 * SVG of a scene, fonts embedded. Embedding costs a fetch + subset of the
 * woff2 files, which is exactly why this is behind the visibility gate and the
 * cache below — but it is also what makes the result self-contained, so a
 * saved .svg still looks hand-drawn on a machine that has never seen Excalifont.
 */
export async function sceneToSvg(scene: LoadedScene, exportPadding = 12, dark = false): Promise<SVGSVGElement> {
  return exportToSvg({
    elements: scene.elements,
    // `exportWithDarkMode` is Excalidraw's own dark rendering (an invert +
    // hue-rotate filter on the root), so a tile in the dark theme does not sit
    // there as a white card. Files saved to disk stay light: they must look
    // right in whatever viewer opens them.
    appState: { ...scene.appState, exportBackground: true, exportWithDarkMode: dark },
    files: scene.files,
    exportPadding,
  })
}

export async function sceneToPngBlob(scene: LoadedScene, maxWidthOrHeight?: number): Promise<Blob> {
  return exportToBlob({
    elements: scene.elements,
    appState: { ...scene.appState, exportBackground: true, exportWithDarkMode: false },
    files: scene.files,
    mimeType: 'image/png',
    maxWidthOrHeight,
  })
}

// ---------------------------------------------------------------------------
// Rendered-SVG cache
//
// Keyed by event id + theme: a diagram message never changes (an edit is a
// new message), so one render per tile per theme per session is all anyone
// should pay.

//
// Bounded by the total size of the markup it holds, not by a count: a
// font-embedded SVG is hundreds of KB to a few MB, so "40 entries" was a
// 40-MB-shaped hole. Least-recently-USED eviction, so scrolling back to the
// diagram you keep looking at doesn't re-render it every time.

const CACHE_MAX_BYTES = 24 * 1024 * 1024
const CACHE_MAX_ENTRIES = 40
const cache = new SvgCache(CACHE_MAX_BYTES, CACHE_MAX_ENTRIES)

export function cachedSvg(key: string): string | undefined {
  return cache.get(key)
}

export async function renderSvgMarkup(key: string, json: string, dark = false): Promise<string> {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const svg = await sceneToSvg(loadScene(json), 12, dark)
  // Let the tile's box drive the size; the viewBox keeps the aspect ratio.
  svg.removeAttribute('width')
  svg.removeAttribute('height')
  svg.setAttribute('style', 'width:100%;height:100%;display:block')
  const markup = svg.outerHTML
  cache.set(key, markup)
  return markup
}

/** Bounds of a scene, for a tile that has to lay out before it has a body. */
export function sceneBounds(scene: LoadedScene): { w: number; h: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of scene.elements) {
    if (el.isDeleted) continue
    minX = Math.min(minX, el.x)
    minY = Math.min(minY, el.y)
    maxX = Math.max(maxX, el.x + el.width)
    maxY = Math.max(maxY, el.y + el.height)
  }
  if (!Number.isFinite(minX)) return { w: 420, h: 320 }
  return { w: Math.max(1, Math.round(maxX - minX)), h: Math.max(1, Math.round(maxY - minY)) }
}
