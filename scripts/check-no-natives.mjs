// Fails the build if any native-module artifact exists in node_modules.
// Native modules would break the "build once on a Mac, run on Windows" story.
// (devDependencies that only run at build time on the Mac — electron itself,
// esbuild/rollup binaries inside vite — are fine; what matters is that nothing
// native gets BUNDLED into out/. electron-vite bundles from source via rollup,
// which cannot bundle .node files, so any .node reachable from src/ imports
// fails the vite build loudly. This gate catches the sneakier case: a dep that
// ships a .node and loads it lazily at runtime.)
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ALLOWED_BUILD_TIME = [
  /^node_modules\/electron\//,
  /^node_modules\/@esbuild\//,
  /^node_modules\/esbuild\//,
  /^node_modules\/@rollup\//,
  /^node_modules\/rollup\//,
  /^node_modules\/@swc\//,
  /^node_modules\/@tailwindcss\//,
  /^node_modules\/lightningcss/,
  // @parcel/watcher ships a prebuilt .node and arrived with 1.2: the diagram
  // editor (@excalidraw/excalidraw) depends on sass, sass depends on chokidar
  // -> @parcel/watcher (optional). It is a BUILD-TIME dep of a dev tool: sass
  // is never imported from src/, so rollup never sees it. The out/ scan below
  // is what keeps that claim honest — it fails if either name ever reaches the
  // shipped bundle.
  /^node_modules\/@parcel\//,
  /^node_modules\/fsevents\//,
  /^node_modules\/app-builder-bin\//,
  /^node_modules\/dmg-builder\//,
  /^node_modules\/electron-builder/,
  /^node_modules\/@electron\//,
  /^node_modules\/@electron-internal\//,
  /^node_modules\/7zip-bin\//,
]

const hits = []
function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      walk(p)
    } else if (e.name.endsWith('.node') || e.name === 'binding.gyp') {
      const rel = p.replace(process.cwd() + '/', '')
      if (!ALLOWED_BUILD_TIME.some((re) => re.test(rel))) hits.push(rel)
    }
  }
}
walk(join(process.cwd(), 'node_modules'))

// Also verify the runtime bundle (out/) is clean.
//
// Two different questions, because the two halves of the bundle are different:
//   - out/main + out/preload are ours, so a literal `.node` string there means a
//     native module got in (the original check, kept);
//   - out/renderer is third-party-heavy (mermaid's minified chunks are full of
//     `.node"` graph accessors), so it is only checked for the names the
//     allowlist above forgives in node_modules: the diagram editor pulled in
//     sass, and sass pulls the optional @parcel/watcher with its prebuilt
//     .node binary. Neither is ever imported from src/, and this is what keeps
//     that claim honest rather than trusting the comment.
// Only meaningful after a build; an unbuilt out/ leaves the node_modules scan
// standing on its own.

const BUNDLE_FORBIDDEN = [
  { re: /node_modules[\\/]sass[\\/]|require\(['"]sass['"]\)|from ['"]sass['"]/, why: 'references sass' },
  { re: /@parcel[\\/]watcher|['"]@parcel[\\/]/, why: 'references @parcel' },
]

const bundleHits = []

function scanBundleDir(rel, { nodeRefs }) {
  let entries
  try {
    entries = readdirSync(join(process.cwd(), rel), { withFileTypes: true })
  } catch {
    return // not built yet
  }
  for (const e of entries) {
    const childRel = `${rel}/${e.name}`
    if (e.isDirectory()) {
      scanBundleDir(childRel, { nodeRefs })
      continue
    }
    if (e.name.endsWith('.node')) bundleHits.push(childRel)
    if (!/\.(js|mjs|cjs)$/.test(e.name)) continue
    const src = readFileSync(join(process.cwd(), childRel), 'utf8')
    if (nodeRefs && /\.node['"]/.test(src)) bundleHits.push(`${childRel} references a .node file`)
    for (const { re, why } of BUNDLE_FORBIDDEN) {
      if (re.test(src)) bundleHits.push(`${childRel} ${why}`)
    }
  }
}

scanBundleDir('out/main', { nodeRefs: true })
scanBundleDir('out/preload', { nodeRefs: true })
scanBundleDir('out/renderer', { nodeRefs: false })

if (hits.length || bundleHits.length) {
  console.error('NATIVE MODULE ARTIFACTS FOUND — cross-platform build story is broken:')
  for (const h of [...hits, ...bundleHits]) console.error('  ' + h)
  process.exit(1)
}
console.log('check-no-natives: clean')
