import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { buildAad } from './envelope'
import {
  buildHeader,
  chunkCount,
  createEncryptStream,
  decryptChunk,
  deriveStreamKey,
  fullChunkRecordSize,
  chunkFileOffset,
  parseHeader,
  readDecryptedRange,
  HEADER_LEN,
} from './blobstream'

const CHUNK = 1024 // small chunks for test speed
const blobKey = randomBytes(32)
const blobId = randomBytes(16)
const baseAad = buildAad('blob', `blobs/xx/${blobId.toString('hex')}.blob`, blobId.toString('hex'))

async function encryptAll(plain: Buffer): Promise<Buffer> {
  const header = { blobId, keySalt: randomBytes(16), chunkSize: CHUNK, totalPlainSize: plain.length }
  const stream = createEncryptStream(blobKey, header, baseAad)
  const out: Buffer[] = []
  await new Promise<void>((res, rej) => {
    Readable.from([plain]).pipe(stream).on('data', (d: Buffer) => out.push(d)).on('end', res).on('error', rej)
  })
  return Buffer.concat(out)
}

describe('SFB1 blob streams', () => {
  it('round-trips a multi-chunk blob via range reads', async () => {
    const plain = randomBytes(CHUNK * 3 + 137)
    const enc = await encryptAll(plain)
    const dir = mkdtempSync(join(tmpdir(), 'sfb1-'))
    const file = join(dir, 'x.blob')
    writeFileSync(file, enc)
    const fd = await open(file, 'r')
    try {
      const all = await readDecryptedRange(fd, blobKey, baseAad, 0, plain.length - 1)
      expect(all.equals(plain)).toBe(true)
      // A mid-file range crossing a chunk boundary
      const mid = await readDecryptedRange(fd, blobKey, baseAad, CHUNK - 10, CHUNK + 9)
      expect(mid.equals(plain.subarray(CHUNK - 10, CHUNK + 10))).toBe(true)
      // Range past EOF clamps
      const tail = await readDecryptedRange(fd, blobKey, baseAad, plain.length - 5, plain.length + 100)
      expect(tail.equals(plain.subarray(plain.length - 5))).toBe(true)
    } finally {
      await fd.close()
    }
  })

  it('round-trips an exact-multiple and a sub-chunk blob', async () => {
    for (const size of [CHUNK * 2, 10, 0]) {
      const plain = randomBytes(size)
      const enc = await encryptAll(plain)
      const header = parseHeader(enc)
      expect(header.totalPlainSize).toBe(size)
      expect(chunkCount(size, CHUNK)).toBeGreaterThanOrEqual(1)
      const dir = mkdtempSync(join(tmpdir(), 'sfb1-'))
      const file = join(dir, 'y.blob')
      writeFileSync(file, enc)
      const fd = await open(file, 'r')
      try {
        const all = await readDecryptedRange(fd, blobKey, baseAad, 0, Math.max(0, size - 1))
        expect(all.equals(plain)).toBe(true)
      } finally {
        await fd.close()
      }
    }
  })

  it('detects chunk reordering', async () => {
    const plain = randomBytes(CHUNK * 2 + 5)
    const enc = await encryptAll(plain)
    const headerBytes = enc.subarray(0, HEADER_LEN)
    const rec0 = enc.subarray(chunkFileOffset(0, CHUNK), chunkFileOffset(0, CHUNK) + fullChunkRecordSize(CHUNK))
    const key = deriveStreamKey(blobKey, parseHeader(enc).keySalt)
    // Chunk 0 presented as chunk 1 must fail auth
    expect(() => decryptChunk(key, Buffer.from(headerBytes), baseAad, 1, Buffer.from(rec0), false)).toThrow()
  })

  it('detects truncation (final marker missing)', async () => {
    const plain = randomBytes(CHUNK * 2 + 5)
    const enc = await encryptAll(plain)
    const headerBytes = enc.subarray(0, HEADER_LEN)
    const key = deriveStreamKey(blobKey, parseHeader(enc).keySalt)
    const rec1 = enc.subarray(chunkFileOffset(1, CHUNK), chunkFileOffset(1, CHUNK) + fullChunkRecordSize(CHUNK))
    // Middle chunk claimed as final must fail auth
    expect(() => decryptChunk(key, Buffer.from(headerBytes), baseAad, 1, Buffer.from(rec1), true)).toThrow()
  })

  it('rejects a foreign AAD (blob copied to another id/path)', async () => {
    const plain = randomBytes(50)
    const enc = await encryptAll(plain)
    const dir = mkdtempSync(join(tmpdir(), 'sfb1-'))
    const file = join(dir, 'z.blob')
    writeFileSync(file, enc)
    const fd = await open(file, 'r')
    try {
      const wrongAad = buildAad('blob', 'blobs/yy/other.blob', 'other')
      await expect(readDecryptedRange(fd, blobKey, wrongAad, 0, 49)).rejects.toThrow()
    } finally {
      await fd.close()
    }
  })

  it('header build/parse round-trips', () => {
    const h = { blobId, keySalt: randomBytes(16), chunkSize: CHUNK, totalPlainSize: 123456 }
    const parsed = parseHeader(buildHeader(h))
    expect(parsed.blobId.equals(h.blobId)).toBe(true)
    expect(parsed.keySalt.equals(h.keySalt)).toBe(true)
    expect(parsed.chunkSize).toBe(CHUNK)
    expect(parsed.totalPlainSize).toBe(123456)
  })
})
