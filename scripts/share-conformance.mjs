#!/usr/bin/env node
// Share conformance harness — run against the REAL shared folder from at least
// one Mac and one Windows machine before trusting the deployment:
//
//   node scripts/share-conformance.mjs /Volumes/TeamShare/probe
//   node scripts/share-conformance.mjs "\\\\server\\share\\probe"    (Windows)
//
// Measures the filesystem semantics the protocol depends on:
//   1. mtime source        — do file mtimes reflect the SERVER clock or the
//                            writer's local clock? (HLC calibration + janitor
//                            age checks assume server; if writer-echo, the app
//                            must calibrate from peer beacons instead)
//   2. rename atomicity    — same-dir rename visibility + no partial reads
//   3. exclusive create    — O_EXCL works (bootstrap race safety)
//   4. listing latency     — readdir freshness after a rename publish
//   5. delete-while-open   — Windows sharing violations (janitor must retry)
//   6. small-file throughput — cold-start sync cost per 1000 events
//
// Prints a constants table to paste into a deployment note.

import { mkdirSync, writeFileSync, renameSync, statSync, readdirSync, openSync, closeSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const root = process.argv[2]
if (!root) {
  console.error('usage: node scripts/share-conformance.mjs <path-on-share>')
  process.exit(1)
}
const dir = join(root, `conformance-${randomBytes(3).toString('hex')}`)
mkdirSync(dir, { recursive: true })
console.log(`probe dir: ${dir}\n`)

const results = {}

// 1. mtime source --------------------------------------------------------
{
  const f = join(dir, 'mtime-probe')
  const t0 = Date.now()
  writeFileSync(f, 'x')
  const st = statSync(f)
  const t1 = Date.now()
  const offset = st.mtimeMs - (t0 + t1) / 2
  results.mtimeOffsetMs = Math.round(offset)
  console.log(`1. mtime offset vs this machine's clock: ${Math.round(offset)} ms`)
  console.log('   → run this from TWO machines with clocks deliberately skewed ±10 min.')
  console.log('   → If each machine sees ~0 offset, mtimes ECHO THE WRITER (bad for janitor);')
  console.log('     if both see the same non-zero offset, the SERVER stamps times (good).')
}

// 2. rename atomicity + visibility --------------------------------------
{
  const tmp = join(dir, 'pub.partial')
  const fin = join(dir, 'pub.final')
  const payload = randomBytes(64 * 1024)
  writeFileSync(tmp, payload)
  const t0 = performance.now()
  renameSync(tmp, fin)
  const renameMs = performance.now() - t0
  const back = readFileSync(fin)
  results.renameMs = +renameMs.toFixed(1)
  results.renameIntact = back.equals(payload)
  console.log(`\n2. same-dir rename: ${renameMs.toFixed(1)} ms, content intact: ${back.equals(payload)}`)
}

// 3. exclusive create ----------------------------------------------------
{
  const f = join(dir, 'excl-probe')
  const fd = openSync(f, 'wx')
  closeSync(fd)
  let second = 'succeeded (BAD)'
  try {
    const fd2 = openSync(f, 'wx')
    closeSync(fd2)
  } catch (err) {
    second = err.code === 'EEXIST' ? 'EEXIST (good)' : `unexpected ${err.code}`
  }
  results.exclusiveCreate = second
  console.log(`\n3. O_EXCL second create: ${second}`)
}

// 4. listing latency after publish --------------------------------------
{
  const name = `vis-${randomBytes(3).toString('hex')}`
  const tmp = join(dir, name + '.partial')
  writeFileSync(tmp, 'v')
  const t0 = performance.now()
  renameSync(tmp, join(dir, name))
  let seen = false
  let tries = 0
  while (!seen && tries < 200) {
    seen = readdirSync(dir).includes(name)
    tries++
  }
  const ms = performance.now() - t0
  results.listingVisibilityMs = +ms.toFixed(1)
  console.log(`\n4. rename → visible in readdir: ${ms.toFixed(1)} ms (${tries} list calls)`)
  console.log('   → run the READ side from a SECOND machine for the real number (SMB dir cache).')
}

// 5. delete-while-open ---------------------------------------------------
{
  const f = join(dir, 'del-probe')
  writeFileSync(f, 'd')
  const fd = openSync(f, 'r')
  let outcome
  try {
    unlinkSync(f)
    outcome = 'delete succeeded while open (POSIX-style)'
  } catch (err) {
    outcome = `delete failed: ${err.code} (janitor must skip-and-retry)`
  }
  closeSync(fd)
  results.deleteWhileOpen = outcome
  console.log(`\n5. delete-while-open: ${outcome}`)
}

// 6. small-file throughput ----------------------------------------------
{
  const N = 200
  const sub = join(dir, 'events')
  mkdirSync(sub)
  const t0 = performance.now()
  for (let i = 0; i < N; i++) {
    const tmp = join(sub, `e${i}.partial`)
    writeFileSync(tmp, randomBytes(1024))
    renameSync(tmp, join(sub, `e${i}`))
  }
  const writeMs = performance.now() - t0
  const t1 = performance.now()
  const names = readdirSync(sub)
  for (const n of names) readFileSync(join(sub, n))
  const readMs = performance.now() - t1
  results.writePerEventMs = +(writeMs / N).toFixed(2)
  results.readPerEventMs = +(readMs / N).toFixed(2)
  console.log(`\n6. ${N} one-KB events: write+rename ${(writeMs / N).toFixed(2)} ms/event, read ${(readMs / N).toFixed(2)} ms/event`)
  console.log(`   → cold-start of 40k events ≈ ${((readMs / N) * 40000 / 1000 / 60).toFixed(1)} min (why day-bundle compaction exists)`)
}

rmSync(dir, { recursive: true, force: true })
console.log('\nSummary JSON:')
console.log(JSON.stringify(results, null, 2))
