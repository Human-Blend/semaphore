#!/usr/bin/env node
// Downloads the bundled offline GIF pack into resources/gifs-starter/.
//
//   node scripts/fetch-gif-pack.mjs
//
// Source: Google's Noto Animated Emoji (CC BY 4.0) — real animated GIF89a
// files served from the Google Fonts CDN. Chosen deliberately over Giphy/Tenor:
// no API key, no per-request network call (the target network blocks both),
// and a license that's safe to redistribute inside a company app.
//
// Run this once on the build Mac; the results are committed so the pack ships
// inside the app and works with zero connectivity.

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Curated for a dev team, grouped by the picker's categories.
const PACK = [
  // Nice
  ['1f44d', 'Nice', 'thumbs up'],
  ['1f44f', 'Nice', 'clap'],
  ['1f4af', 'Nice', 'hundred points'],
  ['2705', 'Nice', 'check mark'],
  ['1f60e', 'Nice', 'sunglasses'],
  ['1f64c', 'Nice', 'raising hands'],
  // Ship it
  ['1f680', 'Ship it', 'rocket'],
  ['1f389', 'Ship it', 'party popper'],
  ['1f38a', 'Ship it', 'confetti ball'],
  ['1f973', 'Ship it', 'partying face'],
  ['26a1', 'Ship it', 'high voltage'],
  ['1f3af', 'Ship it', 'bullseye'],
  // Prod is down
  ['1f525', 'Prod is down', 'fire'],
  ['1f480', 'Prod is down', 'skull'],
  ['1f92f', 'Prod is down', 'exploding head'],
  ['1f631', 'Prod is down', 'screaming'],
  ['1f41b', 'Prod is down', 'bug'],
  ['274c', 'Prod is down', 'cross mark'],
  // Facepalm
  ['1f926', 'Facepalm', 'facepalm'],
  ['1f937', 'Facepalm', 'shrug'],
  ['1f648', 'Facepalm', 'see-no-evil monkey'],
  ['1fae0', 'Facepalm', 'melting face'],
  ['1f643', 'Facepalm', 'upside-down face'],
  ['1f611', 'Facepalm', 'expressionless'],
  ['1f62c', 'Facepalm', 'grimacing'],
  ['1f610', 'Facepalm', 'neutral face'],
  // Looking
  ['1f440', 'Looking', 'eyes'],
  ['1f914', 'Looking', 'thinking face'],
  ['1f4a1', 'Looking', 'light bulb'],
  ['1f9e0', 'Looking', 'brain'],
  // LOL
  ['1f602', 'LOL', 'tears of joy'],
  ['1f923', 'LOL', 'rolling on the floor laughing'],
  ['1f605', 'LOL', 'sweat smile'],
  ['1f62d', 'LOL', 'loudly crying'],
  ['1f92a', 'LOL', 'zany face'],
  ['1f928', 'LOL', 'raised eyebrow'],
  // Please
  ['1f64f', 'Please', 'folded hands'],
  ['1fae1', 'Please', 'saluting face'],
  ['1f97a', 'Please', 'pleading face'],
  ['1f624', 'Please', 'huffing'],
  // Monday
  ['2615', 'Monday', 'coffee'],
  ['1f634', 'Monday', 'sleeping'],
  ['1f971', 'Monday', 'yawning'],
  ['1f355', 'Monday', 'pizza'],
]

// These render at ~200px in the chat, so a multi-megabyte 512px animation is
// pure bundle bloat. Anything over the cap is dropped; the curation above
// leaves every category with at least two survivors.
const MAX_BYTES = 1_200_000

const OUT = join(process.cwd(), 'resources', 'gifs-starter')
mkdirSync(OUT, { recursive: true })

const url = (cp) => `https://fonts.gstatic.com/s/e/notoemoji/latest/${cp}/512.gif`
const manifest = []
let downloaded = 0
let skipped = 0
let bytes = 0

for (const [cp, category, name] of PACK) {
  const file = join(OUT, `${cp}.gif`)
  if (existsSync(file) && statSync(file).size > 1000) {
    manifest.push({ id: cp, category, name, url: `sfgif://pack/${cp}.gif`, w: 512, h: 512 })
    bytes += statSync(file).size
    skipped++
    continue
  }
  const res = await fetch(url(cp))
  if (!res.ok) {
    console.warn(`  ! ${name} (${cp}) unavailable — skipping (${res.status})`)
    continue
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.subarray(0, 6).toString('ascii') !== 'GIF89a') {
    console.warn(`  ! ${name} (${cp}) is not a GIF — skipping`)
    continue
  }
  if (buf.length > MAX_BYTES) {
    console.warn(`  – ${name.padEnd(30)} ${(buf.length / 1024).toFixed(0)} KB — over cap, skipped`)
    continue
  }
  writeFileSync(file, buf)
  bytes += buf.length
  downloaded++
  manifest.push({ id: cp, category, name, url: `sfgif://pack/${cp}.gif`, w: 512, h: 512 })
  process.stdout.write(`  ✓ ${name.padEnd(30)} ${(buf.length / 1024).toFixed(0)} KB\n`)
}

writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))
writeFileSync(
  join(OUT, 'LICENSE.txt'),
  `Noto Animated Emoji
Copyright Google Inc.
Licensed under CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/
Source: https://googlefonts.github.io/noto-emoji-animation/

These animated GIFs ship with Semaphore so the GIF picker works on networks
that block Giphy/Tenor. They are unmodified.
`,
)

console.log(
  `\n${manifest.length} GIFs in the pack (${downloaded} downloaded, ${skipped} cached) — ${(bytes / 1e6).toFixed(1)} MB`,
)
console.log(`manifest: resources/gifs-starter/manifest.json`)
