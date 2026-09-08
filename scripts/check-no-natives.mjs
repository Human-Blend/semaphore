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

// Also verify the runtime bundle (out/) contains no .node references at all.
let bundleHits = []
try {
  for (const sub of ['main', 'preload']) {
    for (const f of readdirSync(join(process.cwd(), 'out', sub))) {
      if (f.endsWith('.node')) bundleHits.push(`out/${sub}/${f}`)
      if (f.endsWith('.js')) {
        const src = readFileSync(join(process.cwd(), 'out', sub, f), 'utf8')
        if (/\.node['"]/.test(src)) bundleHits.push(`out/${sub}/${f} references a .node file`)
      }
    }
  }
} catch {
  // out/ not built yet — node_modules scan alone still valid
}

if (hits.length || bundleHits.length) {
  console.error('NATIVE MODULE ARTIFACTS FOUND — cross-platform build story is broken:')
  for (const h of [...hits, ...bundleHits]) console.error('  ' + h)
  process.exit(1)
}
console.log('check-no-natives: clean')
