#!/usr/bin/env node
// Copies Excalidraw's font files out of node_modules into the renderer's
// public/ dir so the diagram editor is fully self-hosted.
//
// Why this exists: @excalidraw/excalidraw loads its fonts at RUNTIME from
// `window.EXCALIDRAW_ASSET_PATH` and, when that misses, falls back to
// `https://esm.sh/@excalidraw/excalidraw@<v>/dist/prod/` — a CDN the renderer's
// CSP blocks outright (and which a locked-down office network wouldn't reach
// anyway). The fonts must therefore ship inside the app. They can't live in
// `resources/` like the GIF pack: the renderer reaches those only through a
// custom protocol, and Excalidraw builds plain relative URLs. `src/renderer/
// public/` is Vite's publicDir, so everything under it is copied verbatim into
// `out/renderer/` and is addressable from the page in dev (http) and in a
// packaged build (file://) alike.
//
// The copy is gitignored and derived, so this runs from `dev*`, `build` and
// `dist` — `.npmrc` sets `ignore-scripts=true`, which also disables npm's
// `pre*`/`post*` hooks, so the chaining is explicit in package.json.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(process.cwd(), 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod', 'fonts')
const DEST = join(process.cwd(), 'src', 'renderer', 'public', 'excalidraw-assets', 'fonts')
const STAMP = join(process.cwd(), 'src', 'renderer', 'public', 'excalidraw-assets', '.synced')

function tally(dir) {
  let files = 0
  let bytes = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const sub = tally(p)
      files += sub.files
      bytes += sub.bytes
    } else {
      files += 1
      bytes += statSync(p).size
    }
  }
  return { files, bytes }
}

if (!existsSync(SRC)) {
  console.error(
    'sync-excalidraw-assets: @excalidraw/excalidraw is not installed (no dist/prod/fonts).\n' +
      'Run `npm install` first — the diagram editor cannot render text without these fonts.',
  )
  process.exit(1)
}

// Xiaolai is Excalidraw's CJK fallback family: 12 MB of the 13 MB font set,
// for glyphs this team never types. Skipped — CJK text falls back to the
// system font in the editor and in exports. Add it back by deleting the
// entry here and re-running the sync.
const SKIP_FAMILIES = new Set(['Xiaolai'])

const want = tally(SRC)
const stamp = `${want.files} files / ${want.bytes} bytes, skipping ${[...SKIP_FAMILIES].join(',') || 'none'}`

// Cheap idempotence: the fonts only change when the dependency does.
let have = null
try {
  have = existsSync(STAMP) ? readFileSync(STAMP, 'utf8').trim() : null
} catch {
  have = null
}
if (have === stamp && existsSync(DEST)) {
  console.log(`sync-excalidraw-assets: up to date (${stamp})`)
  process.exit(0)
}

rmSync(DEST, { recursive: true, force: true })
mkdirSync(DEST, { recursive: true })
cpSync(SRC, DEST, {
  recursive: true,
  filter: (src) => !SKIP_FAMILIES.has(src.slice(SRC.length + 1).split('/')[0]),
})
writeFileSync(STAMP, `${stamp}\n`)
console.log(`sync-excalidraw-assets: copied ${stamp} -> src/renderer/public/excalidraw-assets/fonts`)
