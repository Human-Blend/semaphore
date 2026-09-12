import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// What the sfblob:// handler says when it cannot find a blob on the share.
//
// 404 is a promise — "this file is gone, stop asking" — and the renderer turns
// it into "cleaned up by retention". An unreachable share looks identical to
// `stat` (ENOENT all the way up), so answering 404 for it made every outage
// look like an expiry and latched the tile on a blurred thumb forever.

const userData = mkdtempSync(join(tmpdir(), 'blobs-test-'))

vi.mock('electron', () => ({
  app: { getPath: () => userData, isPackaged: false },
  dialog: {},
  nativeImage: { createFromDataURL: () => ({}) },
}))

// Capture whatever initProtocol() hands over: handleRequest is private, and
// this is exactly how the real protocol gets hold of it.
const captured = vi.hoisted(() => ({ handler: null as ((req: Request) => Promise<Response>) | null }))
vi.mock('./blobProtocol', () => ({
  setBlobRequestHandler: (h: (req: Request) => Promise<Response>) => {
    captured.handler = h
  },
}))

vi.mock('./staging', () => ({ discardStaged: async () => true }))

const { BlobService, blobMissStatus } = await import('./blobs')

const BLOB_ID = 'ab'.padEnd(32, 'c')
const KEY_B64 = Buffer.alloc(32, 7).toString('base64')

/** A ShareIo stubbed down to what the handler touches. */
function io(opts: Opts) {
  return {
    abs: (rel: string) => join('/nonexistent-share', rel),
    getHealth: () => ({ reachable: opts.reachable, latencyMs: null, lastError: null }),
    statDetailed: async () => ({ stat: null, code: opts.code }),
    // `protocol.json` is what an ENOENT confirms itself against: it is written
    // once when the team is created, so no writer of ours can recreate it in a
    // folder that has gone away.
    statMaybe: async (rel: string) => {
      probes.push(rel)
      return opts.reachable ? { mtimeMs: 1, size: 2 } : null
    },
  }
}

interface Opts {
  /** Is the team folder really there (its protocol file, and cached health)? */
  reachable: boolean
  /** errno from stat-ing the blob itself. */
  code?: string
}

const probes: string[] = []

function handlerFor(opts: Opts): (req: Request) => Promise<Response> {
  captured.handler = null
  probes.length = 0
  const chat = { session: { io: io(opts) } }
  new BlobService(chat as never, () => null, () => {}).initProtocol()
  if (!captured.handler) throw new Error('initProtocol did not register a handler')
  return captured.handler
}

/** Put a complete decrypted copy in the cache so the handler serves 200/206 locally. */
function seedCache(bytes: number): void {
  mkdirSync(join(userData, 'blob-cache'), { recursive: true })
  writeFileSync(join(userData, 'blob-cache', BLOB_ID), Buffer.alloc(bytes, 9))
}

const request = (): Request =>
  new Request(
    `sfblob://blob/${BLOB_ID}?key=${encodeURIComponent(KEY_B64)}&name=${encodeURIComponent('holiday.png')}&size=4096`,
  )

beforeEach(() => {
  captured.handler = null
})

describe('sfblob:// handler, blob not on the share', () => {
  it('answers 404 only when the share is reachable and the file is simply not there', async () => {
    const res = await handlerFor({ reachable: true, code: 'ENOENT' })(request())
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('blob expired')
  })

  it('answers 503 while the share is unreachable, so an outage is not an expiry', async () => {
    // A folder that has been unmounted answers ENOENT for everything inside
    // it, exactly like a swept blob — which is why the miss is confirmed
    // against the share root rather than trusted to cached health.
    const res = await handlerFor({ reachable: false, code: 'ENOENT' })(request())
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('share unreachable')
    expect(probes).toEqual(['protocol.json'])
  })

  it('answers 503 for a stat that failed for any reason other than ENOENT', async () => {
    for (const code of ['EACCES', 'EIO', 'ETIMEDOUT', 'EHOSTDOWN', undefined]) {
      const res = await handlerFor({ reachable: true, code })(request())
      expect(res.status, `code=${code}`).toBe(503)
      // Nothing to confirm: only ENOENT is ambiguous.
      expect(probes, `code=${code}`).toEqual([])
    }
  })

  it('still rejects a malformed blob id outright', async () => {
    const res = await handlerFor({ reachable: true, code: 'ENOENT' })(new Request('sfblob://blob/not-a-blob-id'))
    expect(res.status).toBe(400)
  })

  it('ignores the renderer‘s cache-busting retry parameter', async () => {
    const res = await handlerFor({ reachable: true, code: 'ENOENT' })(
      new Request(
        `sfblob://blob/${BLOB_ID}?key=${encodeURIComponent(KEY_B64)}&name=x.png&size=4096&retry=7`,
      ),
    )
    // Same answer as without it — the parameter changes the URL, nothing else.
    expect(res.status).toBe(404)
  })
})

describe('sfblob:// CORS', () => {
  // sfblob is its own origin, so anything the page reads with fetch() — the
  // diagram tile pulling a scene — is a cross-origin request. Without these
  // headers it fails as "Failed to fetch" with no status to act on, which is
  // why blob-backed scenes never loaded at all.
  const cors = (res: Response) => ({
    allow: res.headers.get('Access-Control-Allow-Origin'),
    expose: res.headers.get('Access-Control-Expose-Headers'),
  })

  it('puts the headers on an error answer', async () => {
    for (const opts of [{ reachable: true, code: 'ENOENT' }, { reachable: false, code: 'ENOENT' }]) {
      const res = await handlerFor(opts)(request())
      expect(cors(res).allow, `status=${res.status}`).toBe('*')
      expect(cors(res).expose).toContain('Content-Range')
      expect(cors(res).expose).toContain('Accept-Ranges')
    }
  })

  it('puts them on a rejected request too', async () => {
    const res = await handlerFor({ reachable: true })(new Request('sfblob://blob/nope'))
    expect(res.status).toBe(400)
    expect(cors(res).allow).toBe('*')
  })

  it('puts them on the body the page is actually after', async () => {
    seedCache(4096)
    try {
      const res = await handlerFor({ reachable: true })(request())
      expect(res.status).toBe(200)
      expect(cors(res).allow).toBe('*')
      expect((await res.arrayBuffer()).byteLength).toBe(4096)
    } finally {
      rmSync(join(userData, 'blob-cache', BLOB_ID), { force: true })
    }
  })

  it('keeps a range read readable — status, headers and all', async () => {
    seedCache(4096)
    try {
      const req = new Request(request(), { headers: { Range: 'bytes=10-19' } })
      const res = await handlerFor({ reachable: true })(req)
      expect(res.status).toBe(206)
      expect(res.headers.get('Content-Range')).toBe('bytes 10-19/4096')
      expect(cors(res).allow).toBe('*')
      expect(cors(res).expose).toContain('Content-Range')
    } finally {
      rmSync(join(userData, 'blob-cache', BLOB_ID), { force: true })
    }
  })

  it('answers a preflight without touching the share', async () => {
    const res = await handlerFor({ reachable: true, code: 'ENOENT' })(
      new Request(request(), { method: 'OPTIONS' }),
    )
    expect(res.status).toBe(204)
    expect(cors(res).allow).toBe('*')
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET')
    expect(probes).toEqual([])
  })
})

describe('blobMissStatus', () => {
  it('is the whole rule in one place', () => {
    expect(blobMissStatus(true, 'ENOENT')).toBe(404)
    expect(blobMissStatus(false, 'ENOENT')).toBe(503)
    expect(blobMissStatus(true, 'EACCES')).toBe(503)
    expect(blobMissStatus(true, undefined)).toBe(503)
    expect(blobMissStatus(false, undefined)).toBe(503)
  })
})
