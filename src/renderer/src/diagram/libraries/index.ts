// The bundled shape libraries. See ATTRIBUTION.md for authors and licences.
//
// Imported as `?url` rather than as JSON: Vite emits each file as a build asset
// and hands us its URL, so half a megabyte of shapes stays out of every JS
// chunk and is fetched only when someone actually opens the editor. (Fetching
// an app-local URL works in dev over http and in a build over file://.)

import flowChartSymbols from './flow-chart-symbols.excalidrawlib?url'
import loFiWireframingKit from './lo-fi-wireframing-kit.excalidrawlib?url'
import softwareArchitecture from './software-architecture.excalidrawlib?url'
import stickyNotes from './sticky-notes.excalidrawlib?url'
import umlErShapes from './uml-er-shapes.excalidrawlib?url'

/** A parsed `.excalidrawlib` file: v2 uses `libraryItems`, v1 used `library`. */
interface RawLibraryFile {
  type?: string
  version?: number
  libraryItems?: unknown
  library?: unknown
}

export const BUNDLED_LIBRARY_URLS: readonly string[] = [
  softwareArchitecture,
  loFiWireframingKit,
  flowChartSymbols,
  umlErShapes,
  stickyNotes,
]

/**
 * Fetch and parse every bundled library. A file that fails to load is skipped —
 * a missing shape set must never keep the editor from opening.
 */
export async function fetchBundledLibraries(): Promise<RawLibraryFile[]> {
  const out: RawLibraryFile[] = []
  await Promise.all(
    BUNDLED_LIBRARY_URLS.map(async (url) => {
      try {
        const res = await fetch(url)
        if (!res.ok) return
        const raw = (await res.json()) as RawLibraryFile
        if (raw && (raw.libraryItems || raw.library)) out.push(raw)
      } catch {
        // offline-by-design app: a library that won't parse is simply absent
      }
    }),
  )
  return out
}

/** The `libraryItems`/`library` payload of one file, whichever version it is. */
export function libraryPayload(raw: RawLibraryFile): unknown {
  return raw.libraryItems ?? raw.library
}
