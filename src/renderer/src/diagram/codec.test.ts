import { describe, expect, it } from 'vitest'
import { DIAGRAM, EVENT } from '@shared/constants'
import {
  diagramFallbackText,
  diagramFitsInline,
  diagramPreview,
  diagramTileKind,
  diagramTitleOf,
  fitDiagramBox,
} from '@shared/diagram'
import { MAX_DECODED_BYTES, decodeScene, encodeScene, encodedLength } from './codec'

// A scene shaped like the real thing: Excalidraw writes one fat object per
// element with ~30 repeated keys, which is exactly why deflate pays.
function scene(elementCount: number): string {
  const elements = Array.from({ length: elementCount }, (_, i) => ({
    id: `el-${i}-${'abcdefgh'.repeat(2)}`,
    type: i % 3 === 0 ? 'rectangle' : i % 3 === 1 ? 'arrow' : 'text',
    x: 100 + i * 17,
    y: 240 - i * 3,
    width: 180,
    height: 64,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    seed: 1234567 + i,
    version: 42,
    versionNonce: 987654321,
    isDeleted: false,
    boundElements: null,
    updated: 1_700_000_000_000 + i,
    link: null,
    locked: false,
    text: i % 3 === 2 ? `step ${i}` : undefined,
    fontFamily: 5,
  }))
  return JSON.stringify(
    { type: 'excalidraw', version: 2, source: 'chat', elements, appState: { viewBackgroundColor: '#ffffff' }, files: {} },
    null,
    2,
  )
}

describe('diagram codec', () => {
  it('round-trips a scene byte-for-byte', async () => {
    const json = scene(24)
    const data = await encodeScene(json)
    expect(await decodeScene(data)).toBe(json)
  })

  it('round-trips unicode and emoji in labels', async () => {
    const json = JSON.stringify({ type: 'excalidraw', elements: [{ text: 'naïve — 図 ✅ 🚀' }] })
    expect(await decodeScene(await encodeScene(json))).toBe(json)
  })

  it('produces base64 only (safe inside a JSON event)', async () => {
    const data = await encodeScene(scene(10))
    expect(data).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
  })

  it('compresses a real-shaped scene by roughly an order of magnitude', async () => {
    const json = scene(120)
    const ratio = json.length / (await encodedLength(json))
    expect(ratio).toBeGreaterThan(5)
  })

  it('rejects input it did not produce', async () => {
    await expect(decodeScene('not base64!!')).rejects.toThrow(/diagram-decode/)
    await expect(decodeScene(btoa('plain text, never deflated'))).rejects.toThrow(/diagram-decode/)
  })

  it('rejects deflated bytes that are not a JSON document', async () => {
    const data = await encodeScene('just a string')
    await expect(decodeScene(data)).rejects.toThrow(/not JSON/)
  })
})

// A deflate stream is a compression bomb: the codec has to refuse the output
// *while* inflating, not after, or the allocation has already happened.
describe('decompression ceiling', () => {
  /** Highly compressible filler shaped like a scene, so the ratio is realistic-plus. */
  const bomb = (bytes: number): string => `{"type":"excalidraw","elements":[],"pad":"${'A'.repeat(bytes)}"}`

  it('refuses a payload that inflates past the ceiling', async () => {
    const data = await encodeScene(bomb(MAX_DECODED_BYTES + 1024))
    // The bomb is tiny on the wire — well inside what a message may carry.
    expect(data.length).toBeLessThan(DIAGRAM.maxInlineBytes)
    await expect(decodeScene(data)).rejects.toThrow(/scene too large/)
  })

  it('still decodes a large-but-sane scene', async () => {
    const json = bomb(1024 * 1024)
    expect(await decodeScene(await encodeScene(json))).toBe(json)
  })

  it('reports the ceiling separately from "this is not a scene"', async () => {
    await expect(decodeScene(await encodeScene(bomb(MAX_DECODED_BYTES + 1024)))).rejects.toThrow(
      /diagram-decode: scene too large/,
    )
    await expect(decodeScene(btoa('plain text, never deflated'))).rejects.toThrow(/not deflate-raw/)
  })
})

describe('inline vs blob decision', () => {
  it('keeps a small scene inline', () => {
    expect(diagramFitsInline(20_000, 20_000)).toBe(true)
  })

  it('sends a scene over the inline ceiling to the blob store', () => {
    expect(diagramFitsInline(DIAGRAM.maxInlineBytes + 1)).toBe(false)
  })

  it('accepts a scene exactly at the inline ceiling', () => {
    expect(diagramFitsInline(DIAGRAM.maxInlineBytes)).toBe(true)
  })

  it('also respects the 256 KB event ceiling once the thumb is counted', () => {
    // Under maxInlineBytes, but scene + thumb + envelope would burst the event.
    expect(diagramFitsInline(DIAGRAM.maxInlineBytes, EVENT.maxFileBytes)).toBe(false)
  })

  it('a real 120-element scene stays inline', async () => {
    expect(diagramFitsInline(await encodedLength(scene(120)), 24 * 1024)).toBe(true)
  })
})

describe('which tile', () => {
  const body = (data?: string) => ({ diagram: { fmt: 'excalidraw' as const, w: 800, h: 600, elements: 3, data } })

  it('renders the inline tile when the scene travels in the event', () => {
    expect(diagramTileKind(body('AAAA'), 0)).toBe('inline')
  })

  it('renders the blob tile when the scene is an attachment', () => {
    expect(diagramTileKind(body(), 1)).toBe('blob')
  })

  it('prefers the inline scene even when an attachment is also present', () => {
    expect(diagramTileKind(body('AAAA'), 1)).toBe('inline')
  })

  it('is broken when there is neither', () => {
    expect(diagramTileKind(body(), 0)).toBe('broken')
    expect(diagramTileKind(body(''), 0)).toBe('broken')
    expect(diagramTileKind({}, 1)).toBe('broken')
  })
})

describe('pre-1.2 fallback line', () => {
  it('names the diagram so a 1.1 client shows something useful', () => {
    expect(diagramFallbackText('Sprint plan')).toBe('📐 Diagram: Sprint plan — update Chat to view it')
  })

  it('round-trips the title back out for the tile', () => {
    for (const t of ['Sprint plan', 'a — b', 'Untitled diagram']) {
      expect(diagramTitleOf(diagramFallbackText(t))).toBe(t)
    }
  })

  it('falls back to a default title for empty input', () => {
    expect(diagramFallbackText('   ')).toBe('📐 Diagram: Untitled diagram — update Chat to view it')
  })

  it('treats an unrecognised body text as the title itself', () => {
    expect(diagramTitleOf('something else entirely')).toBe('something else entirely')
  })

  // What a 1.2 client shows where a tile does not fit: a notification, a reply
  // quote. Never the fallback sentence itself — that tells the user to update
  // the app they are already running.
  it('previews a diagram by name, not by the 1.1 fallback sentence', () => {
    expect(diagramPreview(diagramFallbackText('Sprint plan'))).toBe('📐 Sprint plan')
  })

  it('previews a hand-made or truncated body without the fallback wording', () => {
    expect(diagramPreview('Sprint plan')).toBe('📐 Sprint plan')
    expect(diagramPreview('   ')).toBe('📐 Untitled diagram')
    expect(diagramPreview(diagramFallbackText('Sprint plan'))).not.toMatch(/update Chat/)
  })
})

describe('tile box', () => {
  it('caps a wide scene at the media width', () => {
    expect(fitDiagramBox({ w: 2000, h: 1000 })).toEqual({ w: 420, h: 210 })
  })

  it('caps a tall scene at the media height', () => {
    expect(fitDiagramBox({ w: 400, h: 1600 })).toEqual({ w: 120, h: 320 })
  })

  it('never shrinks below a readable card', () => {
    const box = fitDiagramBox({ w: 10, h: 10 })
    expect(box.w).toBeGreaterThanOrEqual(120)
    expect(box.h).toBeGreaterThanOrEqual(90)
  })
})
