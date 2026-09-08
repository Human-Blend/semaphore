import { app, dialog, nativeImage } from 'electron'
import type { BrowserWindow } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, open, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { AttachDraft, BlobFetchState, PushMessage } from '@shared/bridge'
import type { Attachment, ConvId } from '@shared/types'
import { DIR, FILE_EXT } from '@shared/constants'
import { buildAad } from '../crypto/envelope'
import {
  DEFAULT_CHUNK_SIZE,
  HEADER_LEN,
  chunkCount,
  chunkFileOffset,
  createEncryptStream,
  decryptChunk,
  deriveStreamKey,
  parseHeader,
  readDecryptedRange,
  type BlobHeader,
} from '../crypto/blobstream'
import type { ShareIo } from '../transport/shareIo'
import { setBlobRequestHandler } from './blobProtocol'
import type { ChatService } from './chatService'

// Shared blob store: attachment uploads (SFB1 encrypt-stream → blobs/xx/<id>.blob)
// and downloads (stream-decrypt into a local cache + the sfblob:// protocol that
// serves <img>/<video> with HTTP ranges — uncached ranges are decrypted straight
// off the share so video scrubs over SMB without a full download).
//
// v1 tradeoff, noted deliberately: the local cache under userData/blob-cache
// holds DECRYPTED plaintext on the local disk (same trust domain as the files
// the user drags in). Capped at 2GB with LRU eviction.

const GCM_TAG_LEN = 16
const CACHE_CAP_BYTES = 2 * 1024 * 1024 * 1024
// 1×1 PNG — Electron requires a real (non-empty) drag icon on some platforms.
const DRAG_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// ---------------------------------------------------------------------------
// Small internal helpers shared with the drops service

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  heic: 'image/heic',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  dmg: 'application/x-apple-diskimage',
  exe: 'application/vnd.microsoft.portable-executable',
  msi: 'application/x-msi',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function mimeForName(name: string): string {
  const ext = extname(name).slice(1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

export function sanitizeFileName(name: string): string {
  const base = basename(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
  return base || 'file'
}

function relDir(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

/**
 * Encrypt a local file as SFB1 onto the share: stream to a *.partial tmp path
 * (direct fs write via io.abs — publish() only handles Buffers), then rename
 * into place. One pass computes the plaintext sha256 alongside.
 */
export async function encryptFileToShare(
  io: ShareIo,
  srcPath: string,
  size: number,
  blobKey: Buffer,
  headerBlobId: Buffer,
  relFinal: string,
  baseAad: Buffer,
  tmpRel: string,
  onBytes?: (done: number) => void,
): Promise<{ sha256: string }> {
  await io.ensureDir(relDir(tmpRel))
  await io.ensureDir(relDir(relFinal))
  const header: BlobHeader = {
    blobId: headerBlobId,
    keySalt: randomBytes(16),
    chunkSize: DEFAULT_CHUNK_SIZE,
    totalPlainSize: size,
  }
  const hasher = createHash('sha256')
  let done = 0
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hasher.update(chunk)
      done += chunk.length
      onBytes?.(done)
      cb(null, chunk)
    },
  })
  try {
    await pipeline(
      createReadStream(srcPath),
      tap,
      createEncryptStream(blobKey, header, baseAad),
      createWriteStream(io.abs(tmpRel)),
    )
    await rename(io.abs(tmpRel), io.abs(relFinal))
  } catch (err) {
    await rm(io.abs(tmpRel), { force: true }).catch(() => {})
    throw err
  }
  return { sha256: hasher.digest('hex') }
}

/**
 * Stream-decrypt a whole SFB1 file to a local path, verifying every chunk's
 * GCM tag, returning the plaintext sha256. Removes the partial output on error.
 */
export async function decryptSfb1File(
  absEncPath: string,
  blobKey: Buffer,
  baseAad: Buffer,
  destAbsPath: string,
  onBytes?: (done: number, total: number) => void,
): Promise<{ sha256: string; total: number }> {
  const fd = await open(absEncPath, 'r')
  const ws = createWriteStream(destAbsPath)
  try {
    const head = Buffer.alloc(HEADER_LEN)
    const hr = await fd.read(head, 0, HEADER_LEN, 0)
    if (hr.bytesRead !== HEADER_LEN) throw new Error('SFB1: truncated header')
    const header = parseHeader(head)
    const streamKey = deriveStreamKey(blobKey, header.keySalt)
    const total = header.totalPlainSize
    const chunks = chunkCount(total, header.chunkSize)
    const hasher = createHash('sha256')
    let done = 0
    for (let i = 0; i < chunks; i++) {
      const isFinal = i === chunks - 1
      const plainLen = isFinal ? total - i * header.chunkSize : header.chunkSize
      const recSize = 4 + plainLen + GCM_TAG_LEN
      const rec = Buffer.alloc(recSize)
      const r = await fd.read(rec, 0, recSize, chunkFileOffset(i, header.chunkSize))
      if (r.bytesRead !== recSize) throw new Error('SFB1: truncated chunk')
      const plain = decryptChunk(streamKey, head, baseAad, i, rec, isFinal)
      hasher.update(plain)
      done += plain.length
      if (plain.length && !ws.write(plain)) await once(ws, 'drain')
      onBytes?.(done, total)
    }
    ws.end()
    await once(ws, 'finish')
    return { sha256: hasher.digest('hex'), total }
  } catch (err) {
    ws.destroy()
    await rm(destAbsPath, { force: true }).catch(() => {})
    throw err
  } finally {
    await fd.close().catch(() => {})
  }
}

/** Async-iterable body over a plain local file (optionally a byte range). */
async function* fileBody(path: string, start?: number, end?: number): AsyncGenerator<Uint8Array> {
  const rs = start === undefined ? createReadStream(path) : createReadStream(path, { start, end })
  try {
    for await (const chunk of rs) yield chunk as Buffer
  } finally {
    rs.destroy()
  }
}

type Range = { start: number; end: number } | 'unsatisfiable' | null

function parseRange(header: string | null, size: number): Range {
  if (!header || size <= 0) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (!m[1] && !m[2])) return null
  if (!m[1]) {
    const suffix = Math.min(Number(m[2]), size)
    return suffix === 0 ? 'unsatisfiable' : { start: size - suffix, end: size - 1 }
  }
  const start = Number(m[1])
  if (start >= size) return 'unsatisfiable'
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  return end < start ? 'unsatisfiable' : { start, end }
}

// ---------------------------------------------------------------------------

interface KnownBlob {
  key: Buffer
  name: string
  size: number
}

interface FetchJob {
  snapshot: BlobFetchState
  promise: Promise<BlobFetchState>
}

export class BlobService {
  /** blobId -> key material, registered by fetchBlob AND by sfblob URL params. */
  private known = new Map<string, KnownBlob>()
  private jobs = new Map<string, FetchJob>()
  private readonly cacheDir: string
  private evicting = false

  constructor(
    private chat: ChatService,
    private getWindow: () => BrowserWindow | null,
    private push: (msg: PushMessage) => void,
  ) {
    this.cacheDir = join(app.getPath('userData'), 'blob-cache')
    void mkdir(this.cacheDir, { recursive: true }).catch(() => {})
  }

  /** Wire the sfblob:// protocol to this service (scheme/handler pre-registered). */
  initProtocol(): void {
    setBlobRequestHandler(this.handleRequest)
  }

  private get io(): ShareIo {
    return this.chat.session.io
  }

  private blobRel(blobId: string): string {
    return `${DIR.blobs}/${blobId.slice(0, 2)}/${blobId}${FILE_EXT.blob}`
  }

  private aadFor(blobId: string): Buffer {
    return buildAad('blob', this.blobRel(blobId), blobId)
  }

  private cachePathFor(blobId: string): string {
    return join(this.cacheDir, blobId)
  }

  private urlFor(blobId: string, k: KnownBlob): string {
    return `sfblob://blob/${blobId}?key=${encodeURIComponent(k.key.toString('base64'))}&name=${encodeURIComponent(k.name)}&size=${k.size}`
  }

  // -------------------------------------------------------------------------
  // Upload (wired as chat.attachmentUploader)

  async upload(items: AttachDraft[], _conv: ConvId): Promise<Attachment[]> {
    const out: Attachment[] = []
    for (const item of items) out.push(await this.uploadOne(item))
    return out
  }

  private async uploadOne(item: AttachDraft): Promise<Attachment> {
    const st = await stat(item.path)
    const size = st.size
    const name = basename(item.path)
    const blobId = randomBytes(16).toString('hex')
    const blobKey = randomBytes(32)
    const rel = this.blobRel(blobId)
    const baseAad = this.aadFor(blobId)
    const totalChunks = chunkCount(size, DEFAULT_CHUNK_SIZE)
    const beacon = this.chat.beacon
    let done = 0
    beacon.setXfer(blobId, { done: 0, total: totalChunks })
    const ticker = setInterval(() => {
      beacon.setXfer(blobId, {
        done: Math.min(totalChunks, Math.floor(done / DEFAULT_CHUNK_SIZE)),
        total: totalChunks,
      })
    }, 2000)
    try {
      const { sha256 } = await encryptFileToShare(
        this.io,
        item.path,
        size,
        blobKey,
        Buffer.from(blobId, 'hex'),
        rel,
        baseAad,
        `${DIR.blobsTmp}/${blobId}${FILE_EXT.partial}`,
        (b) => {
          done = b
        },
      )
      this.known.set(blobId, { key: blobKey, name, size })
      // Seed the local cache from the source so our own message renders instantly.
      try {
        await mkdir(this.cacheDir, { recursive: true })
        await copyFile(item.path, this.cachePathFor(blobId))
        void this.evictCache()
      } catch {
        // cache seeding is best-effort
      }
      return {
        blobId,
        key: blobKey.toString('base64'),
        name,
        size,
        mime: mimeForName(name),
        sha256,
        w: item.w,
        h: item.h,
        durMs: item.durMs,
        thumb: item.thumb,
      }
    } finally {
      clearInterval(ticker)
      beacon.setXfer(blobId, null)
    }
  }

  // -------------------------------------------------------------------------
  // Download / cache

  async fetchBlob(blobId: string, key: string, name: string, size: number): Promise<BlobFetchState> {
    const k: KnownBlob = { key: Buffer.from(key, 'base64'), name, size }
    this.known.set(blobId, k)
    return this.fetchKnown(blobId, k)
  }

  private async fetchKnown(blobId: string, k: KnownBlob): Promise<BlobFetchState> {
    const cachePath = this.cachePathFor(blobId)
    const cst = await stat(cachePath).catch(() => null)
    if (cst && cst.size === k.size) {
      void utimes(cachePath, new Date(), new Date()).catch(() => {}) // LRU touch
      const state: BlobFetchState = {
        blobId,
        state: 'ready',
        bytesDone: k.size,
        bytesTotal: k.size,
        url: this.urlFor(blobId, k),
      }
      this.push({ kind: 'blob', state })
      return state
    }
    const existing = this.jobs.get(blobId)
    if (existing) return { ...existing.snapshot }

    const st = await this.io.statMaybe(this.blobRel(blobId))
    if (!st) {
      // Distinguish "janitor cleaned it" from "share is down right now".
      const reachable = this.io.getHealth().reachable
      const state: BlobFetchState = {
        blobId,
        state: reachable ? 'expired' : 'failed',
        bytesDone: 0,
        bytesTotal: k.size,
        url: null,
      }
      this.push({ kind: 'blob', state })
      return state
    }

    const snapshot: BlobFetchState = {
      blobId,
      state: 'downloading',
      bytesDone: 0,
      bytesTotal: k.size,
      url: null,
    }
    const job: FetchJob = { snapshot, promise: Promise.resolve(snapshot) }
    job.promise = this.runFetch(blobId, k, snapshot).finally(() => this.jobs.delete(blobId))
    this.jobs.set(blobId, job)
    this.push({ kind: 'blob', state: { ...snapshot } })
    return { ...snapshot }
  }

  private async runFetch(blobId: string, k: KnownBlob, snapshot: BlobFetchState): Promise<BlobFetchState> {
    const cachePath = this.cachePathFor(blobId)
    const part = `${cachePath}.part-${randomBytes(4).toString('hex')}`
    try {
      await mkdir(this.cacheDir, { recursive: true })
      let lastPush = 0
      await decryptSfb1File(this.io.abs(this.blobRel(blobId)), k.key, this.aadFor(blobId), part, (done, total) => {
        snapshot.bytesDone = done
        snapshot.bytesTotal = total
        const now = Date.now()
        if (now - lastPush >= 250) {
          lastPush = now
          this.push({ kind: 'blob', state: { ...snapshot } })
        }
      })
      await rename(part, cachePath)
      void this.evictCache()
      const state: BlobFetchState = {
        blobId,
        state: 'ready',
        bytesDone: k.size,
        bytesTotal: k.size,
        url: this.urlFor(blobId, k),
      }
      this.push({ kind: 'blob', state })
      return state
    } catch (err) {
      await rm(part, { force: true }).catch(() => {})
      const gone = (err as NodeJS.ErrnoException).code === 'ENOENT'
      const state: BlobFetchState = {
        blobId,
        state: gone ? 'expired' : 'failed',
        bytesDone: 0,
        bytesTotal: k.size,
        url: null,
      }
      this.push({ kind: 'blob', state })
      return state
    }
  }

  /** Resolve the local decrypted cache path, fetching first when needed. */
  private async ensureCached(blobId: string): Promise<string> {
    const k = this.known.get(blobId)
    if (!k) throw new Error('blob-unknown') // renderer always registers via fetchBlob first
    const first = await this.fetchKnown(blobId, k)
    const job = this.jobs.get(blobId)
    const final = job ? await job.promise : first
    if (final.state !== 'ready') throw new Error(`blob-${final.state}`)
    return this.cachePathFor(blobId)
  }

  async saveBlobAs(blobId: string, suggestedName: string): Promise<string | null> {
    const win = this.getWindow()
    const opts = {
      title: 'Save file',
      defaultPath: join(app.getPath('downloads'), sanitizeFileName(suggestedName)),
    }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    const cachePath = await this.ensureCached(blobId)
    await copyFile(cachePath, res.filePath)
    return res.filePath
  }

  async startDrag(blobId: string, name: string): Promise<void> {
    const cachePath = await this.ensureCached(blobId)
    // Cache files are named by blobId — copy under the real name so the drag
    // drops a sensibly-named file.
    const dragDir = join(app.getPath('temp'), 'semaphore-drag')
    await mkdir(dragDir, { recursive: true })
    const dragPath = join(dragDir, sanitizeFileName(name))
    await copyFile(cachePath, dragPath)
    const icon = nativeImage.createFromDataURL(DRAG_ICON_DATA_URL)
    this.getWindow()?.webContents.startDrag({ file: dragPath, icon })
  }

  // -------------------------------------------------------------------------
  // sfblob:// protocol handler — serves from the complete local cache when
  // present, otherwise decrypts the requested range straight off the share.

  private handleRequest = async (req: Request): Promise<Response> => {
    try {
      const u = new URL(req.url)
      const segs = u.pathname.split('/').filter(Boolean)
      const blobId = ((u.host === 'blob' ? segs[0] : u.host) ?? '').toLowerCase()
      if (!/^[0-9a-f]{32}$/.test(blobId)) return new Response('bad blob id', { status: 400 })

      let known = this.known.get(blobId)
      if (!known) {
        const keyParam = u.searchParams.get('key')
        if (!keyParam) return new Response('unknown blob', { status: 404 })
        known = {
          key: Buffer.from(keyParam, 'base64'),
          name: u.searchParams.get('name') ?? 'file',
          size: Number(u.searchParams.get('size') ?? '0'),
        }
        this.known.set(blobId, known)
      }
      const size = known.size
      const mime = mimeForName(known.name)
      const range = parseRange(req.headers.get('range'), size)
      if (range === 'unsatisfiable') {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      const baseHeaders: Record<string, string> = { 'Content-Type': mime, 'Accept-Ranges': 'bytes' }
      if (size === 0) {
        return new Response(null, { status: 200, headers: { ...baseHeaders, 'Content-Length': '0' } })
      }

      const cachePath = this.cachePathFor(blobId)
      const cst = await stat(cachePath).catch(() => null)
      if (cst && cst.size === size) {
        void utimes(cachePath, new Date(), new Date()).catch(() => {})
        if (range) {
          return new Response(fileBody(cachePath, range.start, range.end), {
            status: 206,
            headers: {
              ...baseHeaders,
              'Content-Length': String(range.end - range.start + 1),
              'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
            },
          })
        }
        return new Response(fileBody(cachePath), {
          status: 200,
          headers: { ...baseHeaders, 'Content-Length': String(size) },
        })
      }

      // Not cached (or cache incomplete): decrypt the requested range directly
      // from the encrypted share file — this is what makes video scrub over SMB.
      const rel = this.blobRel(blobId)
      const st = await this.io.statMaybe(rel)
      if (!st) return new Response('blob expired', { status: 404 })
      const start = range ? range.start : 0
      const end = range ? range.end : size - 1
      const body = this.shareBody(this.io.abs(rel), known.key, this.aadFor(blobId), start, end)
      if (range) {
        return new Response(body, {
          status: 206,
          headers: {
            ...baseHeaders,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${size}`,
          },
        })
      }
      return new Response(body, {
        status: 200,
        headers: { ...baseHeaders, 'Content-Length': String(size) },
      })
    } catch (err) {
      return new Response(err instanceof Error ? err.message : 'blob error', { status: 500 })
    }
  }

  /** Progressive decrypted body over [start, end], pulled in 4-chunk slices. */
  private async *shareBody(
    absPath: string,
    key: Buffer,
    baseAad: Buffer,
    start: number,
    end: number,
  ): AsyncGenerator<Uint8Array> {
    const fd = await open(absPath, 'r')
    try {
      const sliceBytes = 4 * DEFAULT_CHUNK_SIZE
      let pos = start
      while (pos <= end) {
        const sliceEnd = Math.min(end, pos + sliceBytes - 1)
        const buf = await readDecryptedRange(fd, key, baseAad, pos, sliceEnd)
        if (buf.length === 0) break
        yield buf
        pos = sliceEnd + 1
      }
    } finally {
      await fd.close().catch(() => {})
    }
  }

  // -------------------------------------------------------------------------
  // LRU cache eviction (cap: 2GB of decrypted plaintext)

  private async evictCache(): Promise<void> {
    if (this.evicting) return
    this.evicting = true
    try {
      const names = await readdir(this.cacheDir).catch(() => [] as string[])
      const files: { path: string; name: string; size: number; mtimeMs: number }[] = []
      for (const n of names) {
        const p = join(this.cacheDir, n)
        const s = await stat(p).catch(() => null)
        if (s?.isFile()) files.push({ path: p, name: n, size: s.size, mtimeMs: s.mtimeMs })
      }
      let total = files.reduce((a, f) => a + f.size, 0)
      // Orphaned partials from crashed fetches: clean after a day regardless.
      const dayAgo = Date.now() - 24 * 60 * 60_000
      for (const f of files) {
        if (f.name.includes('.part-') && f.mtimeMs < dayAgo) {
          await rm(f.path, { force: true }).catch(() => {})
          total -= f.size
        }
      }
      if (total <= CACHE_CAP_BYTES) return
      files.sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const f of files) {
        if (total <= CACHE_CAP_BYTES) break
        if (f.name.includes('.part-') || this.jobs.has(f.name)) continue
        await rm(f.path, { force: true }).catch(() => {})
        total -= f.size
      }
    } finally {
      this.evicting = false
    }
  }
}
