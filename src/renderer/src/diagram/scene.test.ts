import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Attachment } from '@shared/types'
import { DIAGRAM } from '@shared/constants'
import { bytesIncludeMarker, fetchBlobScene, sceneSignature } from './scene'

// The renderer-free half of the diagram send/receive path. Nothing here loads
// Excalidraw, which is the point: these are the decisions a tile makes before
// (or without ever) reaching the 1 MB chunk.

const att = (over: Partial<Attachment> = {}): Attachment => ({
  blobId: 'deadbeef',
  key: 'a2V5',
  name: 'Sprint plan.excalidraw',
  size: 4096,
  mime: DIAGRAM.mime,
  sha256: 'x',
  ...over,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubBridge(state: string, fetchImpl?: () => Promise<unknown>): { fetchBlob: ReturnType<typeof vi.fn> } {
  const fetchBlob = vi.fn(async () => ({ state }))
  vi.stubGlobal('window', { bridge: { files: { fetchBlob } } })
  vi.stubGlobal('fetch', vi.fn(fetchImpl ?? (async () => ({ ok: true, text: async () => '{}' }))))
  return { fetchBlob }
}

describe('fetchBlobScene', () => {
  it('returns the scene text on the happy path', async () => {
    stubBridge('ready', async () => ({ ok: true, text: async () => '{"type":"excalidraw"}' }))
    await expect(fetchBlobScene(att())).resolves.toBe('{"type":"excalidraw"}')
  })

  it('reports an expired blob as null, and never fetches it', async () => {
    stubBridge('expired')
    await expect(fetchBlobScene(att())).resolves.toBeNull()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('reports a failed fetch of a ready blob as null', async () => {
    stubBridge('ready', async () => ({ ok: false, status: 404, text: async () => 'nope' }))
    await expect(fetchBlobScene(att())).resolves.toBeNull()
  })

  it('is null for a diagram message that carries no attachment at all', async () => {
    const { fetchBlob } = stubBridge('ready')
    await expect(fetchBlobScene(undefined)).resolves.toBeNull()
    expect(fetchBlob).not.toHaveBeenCalled()
  })

  it('asks the blob service for exactly the attachment it was given', async () => {
    const { fetchBlob } = stubBridge('ready')
    await fetchBlobScene(att({ blobId: 'b1', key: 'k1', name: 'n', size: 7 }))
    expect(fetchBlob).toHaveBeenCalledWith('b1', 'k1', 'n', 7)
  })
})

describe('sceneSignature', () => {
  const e = (version: number, versionNonce: number): { version: number; versionNonce: number } => ({
    version,
    versionNonce,
  })

  it('is stable when nothing about the elements changed (a pan, a zoom, a tool pick)', () => {
    const els = [e(1, 111), e(2, 222)]
    expect(sceneSignature(els)).toBe(sceneSignature([...els]))
  })

  it('changes when an element is added or removed', () => {
    const els = [e(1, 111), e(2, 222)]
    expect(sceneSignature([...els, e(1, 333)])).not.toBe(sceneSignature(els))
    expect(sceneSignature(els.slice(1))).not.toBe(sceneSignature(els))
  })

  it('changes when an element is edited — including one that is not the last', () => {
    const before = [e(1, 111), e(2, 222), e(3, 333)]
    const after = [e(2, 999), e(2, 222), e(3, 333)]
    expect(sceneSignature(after)).not.toBe(sceneSignature(before))
  })

  it('distinguishes a reorder', () => {
    expect(sceneSignature([e(1, 111), e(2, 222)])).not.toBe(sceneSignature([e(2, 222), e(1, 111)]))
  })

  it('handles an empty canvas and undefined fields', () => {
    expect(sceneSignature([])).toBe('0:0')
    expect(sceneSignature([{}])).toBe(sceneSignature([{}]))
  })
})

describe('bytesIncludeMarker', () => {
  const bytes = (s: string): Uint8Array => new Uint8Array([...s].map((c) => c.charCodeAt(0)))

  it('finds the marker near the start of a PNG-shaped buffer', () => {
    const buf = new Uint8Array(4096)
    buf.set(bytes(DIAGRAM.mime), 40)
    expect(bytesIncludeMarker(buf, DIAGRAM.mime)).toBe(true)
  })

  it('finds the marker near the end of an SVG-shaped buffer', () => {
    const buf = new Uint8Array(4096)
    buf.set(bytes(DIAGRAM.mime), 4096 - DIAGRAM.mime.length - 10)
    expect(bytesIncludeMarker(buf, DIAGRAM.mime)).toBe(true)
  })

  it('says no when the marker is absent', () => {
    expect(bytesIncludeMarker(new Uint8Array(4096), DIAGRAM.mime)).toBe(false)
    expect(bytesIncludeMarker(bytes('short'), DIAGRAM.mime)).toBe(false)
    expect(bytesIncludeMarker(bytes('abc'), '')).toBe(false)
  })

  it('only looks at both ends of a big file, and finds a marker straddling the window edge', () => {
    const window = 64
    const buf = new Uint8Array(4096)
    buf.set(bytes(DIAGRAM.mime), window - 4) // half in, half out of the head window
    expect(bytesIncludeMarker(buf, DIAGRAM.mime, window)).toBe(true)

    const middle = new Uint8Array(4096)
    middle.set(bytes(DIAGRAM.mime), 2000)
    expect(bytesIncludeMarker(middle, DIAGRAM.mime, window)).toBe(false)
  })

  it('matches bytes rather than decoded text (a marker after invalid UTF-8)', () => {
    const buf = new Uint8Array([0xff, 0xfe, 0x00, 0x80, ...bytes(DIAGRAM.mime)])
    expect(bytesIncludeMarker(buf, DIAGRAM.mime)).toBe(true)
  })
})
