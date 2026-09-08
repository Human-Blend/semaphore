import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto'
import { Transform } from 'node:stream'
import type { FileHandle } from 'node:fs/promises'
import { BLOB, HKDF_INFO } from '@shared/constants'

// SFB1 — chunked authenticated stream for blobs of any size (STREAM
// construction: per-chunk nonces carrying the chunk index plus a final-chunk
// marker, so truncation, reordering, and chunk-swapping all fail auth).
//
// Layout (big-endian):
//   header: magic "SFB1" | version 0x01 | suite 0x02 | blobId 16B | keySalt 16B
//           | chunkSize u32 | totalPlainSize u64 (0 if unknown at start)
//   chunks: ctLen u32 | ciphertext | tag 16B      (repeated)
//
// AES-GCM ciphertext length equals plaintext length, so every chunk except the
// final one occupies exactly 4 + chunkSize + 16 bytes — random access for the
// sfblob:// streaming protocol is plain offset arithmetic.

const MAGIC = Buffer.from('SFB1', 'ascii')
const VERSION = 0x01
const SUITE = 0x02
export const HEADER_LEN = 4 + 1 + 1 + 16 + 16 + 4 + 8
const TAG_LEN = 16

export interface BlobHeader {
  blobId: Buffer // 16 bytes
  keySalt: Buffer
  chunkSize: number
  totalPlainSize: number
}

export function buildHeader(h: BlobHeader): Buffer {
  const buf = Buffer.alloc(HEADER_LEN)
  MAGIC.copy(buf, 0)
  buf[4] = VERSION
  buf[5] = SUITE
  h.blobId.copy(buf, 6)
  h.keySalt.copy(buf, 22)
  buf.writeUInt32BE(h.chunkSize, 38)
  buf.writeBigUInt64BE(BigInt(h.totalPlainSize), 42)
  return buf
}

export function parseHeader(buf: Buffer): BlobHeader {
  if (buf.length < HEADER_LEN || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('SFB1: bad magic')
  if (buf[4] !== VERSION || buf[5] !== SUITE) throw new Error('SFB1: unsupported version/suite')
  return {
    blobId: Buffer.from(buf.subarray(6, 22)),
    keySalt: Buffer.from(buf.subarray(22, 38)),
    chunkSize: buf.readUInt32BE(38),
    totalPlainSize: Number(buf.readBigUInt64BE(42)),
  }
}

export function deriveStreamKey(blobKey: Buffer, keySalt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', blobKey, keySalt, HKDF_INFO.stream, 32))
}

function chunkNonce(index: number, final: boolean): Buffer {
  const n = Buffer.alloc(12)
  n.writeBigUInt64BE(BigInt(index), 0)
  n[11] = final ? 0x01 : 0x00
  return n
}

function chunkAad(headerBytes: Buffer, baseAad: Buffer, index: number): Buffer {
  const idx = Buffer.alloc(8)
  idx.writeBigUInt64BE(BigInt(index), 0)
  return Buffer.concat([headerBytes, baseAad, idx])
}

export function encryptChunk(
  streamKey: Buffer,
  headerBytes: Buffer,
  baseAad: Buffer,
  index: number,
  plain: Buffer,
  final: boolean,
): Buffer {
  const cipher = createCipheriv('aes-256-gcm', streamKey, chunkNonce(index, final))
  cipher.setAAD(chunkAad(headerBytes, baseAad, index))
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  const len = Buffer.alloc(4)
  len.writeUInt32BE(ct.length, 0)
  return Buffer.concat([len, ct, tag])
}

export function decryptChunk(
  streamKey: Buffer,
  headerBytes: Buffer,
  baseAad: Buffer,
  index: number,
  chunkRecord: Buffer, // ctLen | ct | tag
  final: boolean,
): Buffer {
  const ctLen = chunkRecord.readUInt32BE(0)
  const ct = chunkRecord.subarray(4, 4 + ctLen)
  const tag = chunkRecord.subarray(4 + ctLen, 4 + ctLen + TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', streamKey, chunkNonce(index, final))
  decipher.setAAD(chunkAad(headerBytes, baseAad, index))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

/** Byte offset of chunk `index` within the encrypted file. */
export function chunkFileOffset(index: number, chunkSize: number): number {
  return HEADER_LEN + index * (4 + chunkSize + TAG_LEN)
}

/** On-disk size of a full (non-final) chunk record. */
export function fullChunkRecordSize(chunkSize: number): number {
  return 4 + chunkSize + TAG_LEN
}

export function chunkCount(totalPlainSize: number, chunkSize: number): number {
  return totalPlainSize === 0 ? 1 : Math.ceil(totalPlainSize / chunkSize)
}

/**
 * Transform stream: plaintext in → SFB1 bytes out (header first). Constant
 * memory for multi-GB files. totalPlainSize must be known up front (we always
 * know file sizes before upload).
 */
export function createEncryptStream(blobKey: Buffer, header: BlobHeader, baseAad: Buffer): Transform {
  const headerBytes = buildHeader(header)
  const streamKey = deriveStreamKey(blobKey, header.keySalt)
  const chunkSize = header.chunkSize
  const total = header.totalPlainSize
  let buffered: Buffer[] = []
  let bufferedLen = 0
  let index = 0
  let plainDone = 0
  let headerSent = false

  const flushChunk = (t: Transform, final: boolean) => {
    const plain = Buffer.concat(buffered, bufferedLen)
    buffered = []
    bufferedLen = 0
    plainDone += plain.length
    t.push(encryptChunk(streamKey, headerBytes, baseAad, index, plain, final))
    index += 1
  }

  return new Transform({
    transform(data: Buffer, _enc, cb) {
      try {
        if (!headerSent) {
          this.push(headerBytes)
          headerSent = true
        }
        let chunk = data
        while (chunk.length > 0) {
          const room = chunkSize - bufferedLen
          const take = chunk.subarray(0, room)
          buffered.push(take)
          bufferedLen += take.length
          chunk = chunk.subarray(take.length)
          if (bufferedLen === chunkSize && plainDone + bufferedLen < total) {
            flushChunk(this, false)
          }
        }
        cb()
      } catch (err) {
        cb(err as Error)
      }
    },
    flush(cb) {
      try {
        if (!headerSent) {
          this.push(headerBytes)
          headerSent = true
        }
        flushChunk(this, true) // final chunk, possibly empty (zero-byte blob)
        cb()
      } catch (err) {
        cb(err as Error)
      }
    },
  })
}

/**
 * Decrypt one plaintext byte range from an open SFB1 file (random access for
 * video scrubbing over SMB). Reads only the chunks the range touches.
 */
export async function readDecryptedRange(
  fd: FileHandle,
  blobKey: Buffer,
  baseAad: Buffer,
  start: number,
  end: number, // inclusive
): Promise<Buffer> {
  const headBuf = Buffer.alloc(HEADER_LEN)
  await fd.read(headBuf, 0, HEADER_LEN, 0)
  const header = parseHeader(headBuf)
  const streamKey = deriveStreamKey(blobKey, header.keySalt)
  const { chunkSize, totalPlainSize } = header
  const lastIndex = chunkCount(totalPlainSize, chunkSize) - 1
  const clampedEnd = Math.min(end, totalPlainSize - 1)
  if (clampedEnd < start) return Buffer.alloc(0)

  const firstChunk = Math.floor(start / chunkSize)
  const lastChunk = Math.floor(clampedEnd / chunkSize)
  const parts: Buffer[] = []
  for (let i = firstChunk; i <= lastChunk; i++) {
    const isFinal = i === lastIndex
    const plainLen = isFinal ? totalPlainSize - i * chunkSize : chunkSize
    const recSize = 4 + plainLen + TAG_LEN
    const rec = Buffer.alloc(recSize)
    await fd.read(rec, 0, recSize, chunkFileOffset(i, chunkSize))
    const plain = decryptChunk(streamKey, headBuf, baseAad, i, rec, isFinal)
    const sliceStart = i === firstChunk ? start - i * chunkSize : 0
    const sliceEnd = i === lastChunk ? clampedEnd - i * chunkSize + 1 : plain.length
    parts.push(plain.subarray(sliceStart, sliceEnd))
  }
  return Buffer.concat(parts)
}

export const DEFAULT_CHUNK_SIZE = BLOB.chunkBytes
