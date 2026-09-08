#!/usr/bin/env node
// Generates build/icon.icns (macOS) and build/icon.ico (Windows) procedurally —
// no image tooling required. Design: dark superellipse tile, indigo→violet
// diagonal wash, a white semaphore flag pair (the app's namesake) with a warm
// flare dot. Rendered with signed-distance functions + 3x supersampling.

import { deflateSync } from 'node:zlib'
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SIZE = 1024
const SS = 3 // supersample factor

// ---------------------------------------------------------------------------
// Scene (all coordinates in unit space 0..1)

const mix = (a, b, t) => a + (b - a) * t
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const smooth = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

// Superellipse (squircle) SDF-ish coverage
function squircle(x, y, cx, cy, r, n = 4.5) {
  const dx = Math.abs(x - cx) / r
  const dy = Math.abs(y - cy) / r
  return Math.pow(dx, n) + Math.pow(dy, n) - 1
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax
  const pay = py - ay
  const bax = bx - ax
  const bay = by - ay
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1)
  const dx = pax - bax * h
  const dy = pay - bay * h
  return Math.hypot(dx, dy)
}

function sdTriangle(px, py, p0, p1, p2) {
  const sign = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  const d1 = sign(p0[0], p0[1], p1[0], p1[1], px, py)
  const d2 = sign(p1[0], p1[1], p2[0], p2[1], px, py)
  const d3 = sign(p2[0], p2[1], p0[0], p0[1], px, py)
  const inside = (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)
  const dist = Math.min(
    sdSegment(px, py, p0[0], p0[1], p1[0], p1[1]),
    sdSegment(px, py, p1[0], p1[1], p2[0], p2[1]),
    sdSegment(px, py, p2[0], p2[1], p0[0], p0[1]),
  )
  return inside ? -dist : dist
}

function shade(x, y) {
  // Background: transparent outside the tile
  const sq = squircle(x, y, 0.5, 0.5, 0.44)
  const aa = 0.02
  const tileCov = 1 - smooth(-aa, aa, sq)
  if (tileCov <= 0) return [0, 0, 0, 0]

  // Tile fill: diagonal indigo wash on near-black
  const t = clamp((x + y) / 2, 0, 1)
  let r = mix(0x17, 0x2a, t)
  let g = mix(0x18, 0x24, t)
  let b = mix(0x2b, 0x55, t)
  // Soft radial glow upper-left
  const glow = Math.exp(-(((x - 0.33) ** 2 + (y - 0.3) ** 2) / 0.09)) * 0.55
  r = mix(r, 0x7b, glow * 0.45)
  g = mix(g, 0x80, glow * 0.45)
  b = mix(b, 0xff, glow * 0.45)

  // Flag pole: from lower-left to upper-right area
  const poleA = [0.36, 0.78]
  const poleB = [0.36, 0.2]
  const dPole = sdSegment(x, y, poleA[0], poleA[1], poleB[0], poleB[1]) - 0.018
  // Upper flag (large, flying right)
  const flag1 = sdTriangle(x, y, [0.375, 0.2], [0.74, 0.3], [0.375, 0.44])
  // Lower flag (smaller, accented)
  const flag2 = sdTriangle(x, y, [0.375, 0.5], [0.64, 0.575], [0.375, 0.68])

  const aaF = 0.008
  const covPole = 1 - smooth(-aaF, aaF, dPole)
  const covF1 = 1 - smooth(-aaF, aaF, flag1)
  const covF2 = 1 - smooth(-aaF, aaF, flag2)

  // White pole + flag 1
  const white = Math.max(covPole, covF1)
  r = mix(r, 0xf2, white)
  g = mix(g, 0xf3, white)
  b = mix(b, 0xf8, white)
  // Flare flag 2 (warm orange)
  r = mix(r, 0xff, covF2)
  g = mix(g, 0x94, covF2)
  b = mix(b, 0x57, covF2)

  return [Math.round(r), Math.round(g), Math.round(b), Math.round(255 * tileCov)]
}

function render(size) {
  const px = Buffer.alloc(size * size * 4)
  for (let yy = 0; yy < size; yy++) {
    for (let xx = 0; xx < size; xx++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (xx + (sx + 0.5) / SS) / size
          const v = (yy + (sy + 0.5) / SS) / size
          const [pr, pg, pb, pa] = shade(u, v)
          r += pr * pa
          g += pg * pa
          b += pb * pa
          a += pa
        }
      }
      const n = SS * SS
      const i = (yy * size + xx) * 4
      const alpha = a / n
      px[i] = alpha > 0 ? Math.round(r / a) : 0
      px[i + 1] = alpha > 0 ? Math.round(g / a) : 0
      px[i + 2] = alpha > 0 ? Math.round(b / a) : 0
      px[i + 3] = Math.round(alpha)
    }
  }
  return px
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder

function crc32(buf) {
  let c
  const table = crc32.table ?? (crc32.table = Array.from({ length: 256 }, (_, n) => {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  }))
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  // Filter byte 0 per scanline
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Nearest-ish downscale with box filter (good enough for icon sizes)
function downscale(pixels, from, to) {
  const out = Buffer.alloc(to * to * 4)
  const ratio = from / to
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0
      const y0 = Math.floor(y * ratio)
      const y1 = Math.min(from, Math.ceil((y + 1) * ratio))
      const x0 = Math.floor(x * ratio)
      const x1 = Math.min(from, Math.ceil((x + 1) * ratio))
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * from + xx) * 4
          const pa = pixels[i + 3]
          r += pixels[i] * pa
          g += pixels[i + 1] * pa
          b += pixels[i + 2] * pa
          a += pa
          n++
        }
      }
      const o = (y * to + x) * 4
      out[o] = a ? Math.round(r / a) : 0
      out[o + 1] = a ? Math.round(g / a) : 0
      out[o + 2] = a ? Math.round(b / a) : 0
      out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

// ---------------------------------------------------------------------------

console.log('rendering master 1024×1024…')
const master = render(SIZE)
const buildDir = join(process.cwd(), 'build')
mkdirSync(buildDir, { recursive: true })

const pngOf = (size) => encodePng(size === SIZE ? master : downscale(master, SIZE, size), size)

// macOS .icns via iconutil
const iconset = join(buildDir, 'icon.iconset')
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset)
const entries = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]
for (const [name, size] of entries) writeFileSync(join(iconset, name), pngOf(size))
execSync(`iconutil -c icns "${iconset}" -o "${join(buildDir, 'icon.icns')}"`)
rmSync(iconset, { recursive: true, force: true })
console.log('build/icon.icns written')

// Windows .ico (PNG-compressed entries)
const icoSizes = [256, 64, 48, 32, 16]
const pngs = icoSizes.map((s) => pngOf(s))
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(icoSizes.length, 4)
let offset = 6 + 16 * icoSizes.length
const dirs = []
for (let i = 0; i < icoSizes.length; i++) {
  const d = Buffer.alloc(16)
  d[0] = icoSizes[i] === 256 ? 0 : icoSizes[i]
  d[1] = icoSizes[i] === 256 ? 0 : icoSizes[i]
  d[4] = 1 // planes lo
  d[6] = 32 // bpp lo
  d.writeUInt32LE(pngs[i].length, 8)
  d.writeUInt32LE(offset, 12)
  offset += pngs[i].length
  dirs.push(d)
}
writeFileSync(join(buildDir, 'icon.ico'), Buffer.concat([header, ...dirs, ...pngs]))
console.log('build/icon.ico written')

// A renderer-usable copy for the onboarding hero / about pane
writeFileSync(join(process.cwd(), 'resources', 'icon.png'), pngOf(512))
console.log('resources/icon.png written')
