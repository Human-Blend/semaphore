// Turning a canvas full of shapes into a message, and back.
//
// Nothing here imports Excalidraw: the heavy module stays behind the lazy
// boundary in DiagramEditor/render.ts, and these helpers only deal in the
// blobs and JSON that come out the other side. That keeps them usable from the
// tile (which may never load the editor) and from the drop handler.

import type { AttachDraft, SendDraft } from '@shared/bridge'
import type { Attachment, DiagramBody } from '@shared/types'
import { DIAGRAM, EVENT } from '@shared/constants'
import { cleanTitle, diagramFileStem, diagramFitsInline } from '@shared/diagram'
import { blobUrl } from '@/content/parse'
import { encodeScene } from './codec'

/** Instant-preview thumb: progressively cheaper until it fits the event budget. */
const THUMB_STEPS: readonly { edge: number; quality: number }[] = [
  { edge: 512, quality: 0.7 },
  { edge: 512, quality: 0.45 },
  { edge: 384, quality: 0.45 },
  { edge: 256, quality: 0.5 },
  { edge: 160, quality: 0.5 },
]

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image()
    img.onload = () => res(img)
    img.onerror = () => rej(new Error('diagram-thumb: undecodable'))
    img.src = url
  })
}

/**
 * A WebP data: URI of the rendered scene, inside `EVENT.maxThumbBytes` (24 KB).
 * This is what paints the instant the message arrives — before anything has
 * decoded the scene, and forever on a client that never loads the editor.
 */
export async function makeSceneThumb(png: Blob): Promise<string | undefined> {
  const url = URL.createObjectURL(png)
  try {
    const img = await loadImage(url)
    const w = img.naturalWidth
    const h = img.naturalHeight
    if (!w || !h) return undefined
    for (const step of THUMB_STEPS) {
      const scale = Math.min(1, step.edge / Math.max(w, h))
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(w * scale))
      c.height = Math.max(1, Math.round(h * scale))
      const ctx = c.getContext('2d')
      if (!ctx) return undefined
      // Diagrams are line art on a light ground: without this the transparent
      // PNG turns into black-on-black in the dark theme.
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, c.width, c.height)
      ctx.drawImage(img, 0, 0, c.width, c.height)
      const uri = c.toDataURL('image/webp', step.quality)
      if (uri.length <= EVENT.maxThumbBytes) return uri
    }
    return undefined
  } catch {
    return undefined // a thumb is a nicety; the scene itself is the message
  } finally {
    URL.revokeObjectURL(url)
  }
}

export interface SceneExport {
  /** The .excalidraw JSON document (`serializeAsJSON` output). */
  json: string
  /** PNG of the scene, for the thumb. */
  png: Blob
  /** Scene bounds in px. */
  w: number
  h: number
  elements: number
}

export interface DiagramSendPlan {
  draft: SendDraft
  transport: 'inline' | 'blob'
}

/**
 * Decide how a finished scene travels, and build the draft.
 *
 * Small scenes (compressed ≤ DIAGRAM.maxInlineBytes, and small enough that the
 * whole event still clears EVENT.maxFileBytes) ride inside the message: no blob
 * to fetch, no share I/O to read them, and the 180-day message retention. Big
 * ones become a `.excalidraw` attachment instead and inherit the blob store's
 * 7-day sweep — the tile says so, out loud, rather than quietly rotting.
 */
export async function planDiagramSend(
  title: string,
  scene: SceneExport,
  opts: { replyTo?: string } = {},
): Promise<DiagramSendPlan> {
  const name = cleanTitle(title)
  const thumb = await makeSceneThumb(scene.png)
  const data = await encodeScene(scene.json)
  const body: DiagramBody = {
    fmt: 'excalidraw',
    w: Math.round(scene.w),
    h: Math.round(scene.h),
    elements: scene.elements,
    thumb,
  }

  if (diagramFitsInline(data.length, thumb?.length ?? 0)) {
    return {
      transport: 'inline',
      draft: { text: name, kind: 'diagram', diagram: { ...body, data }, replyTo: opts.replyTo },
    }
  }

  const staged = await window.bridge.files.stageBytes(
    `${diagramFileStem(name)}${DIAGRAM.ext}`,
    bytesToBase64(new TextEncoder().encode(scene.json)),
  )
  const attachment: AttachDraft = { path: staged.path, thumb, w: body.w, h: body.h }
  return {
    transport: 'blob',
    draft: { text: name, kind: 'diagram', diagram: body, attachments: [attachment], replyTo: opts.replyTo },
  }
}

const CHUNK = 0x8000

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += CHUNK) out += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(out)
}

export function base64ToText(b64: string): string {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(out)
}

/**
 * Does this dropped file carry an Excalidraw scene? `.excalidraw` by name, or a
 * PNG/SVG exported with "embed scene" — those carry the source JSON in a
 * private PNG chunk / an <!-- payload --> comment, which Excalidraw's own
 * `loadFromBlob` knows how to dig out. We only decide *whether to try* here;
 * the editor does the digging.
 */
export function looksLikeDiagramFile(file: { name: string; type: string }): boolean {
  const name = file.name.toLowerCase()
  if (name.endsWith(DIAGRAM.ext) || name.endsWith('.excalidrawlib')) return true
  if (file.type === DIAGRAM.mime) return true
  return name.endsWith('.png') || name.endsWith('.svg') || file.type === 'image/png' || file.type === 'image/svg+xml'
}

/** Only a `.excalidraw` file is a certain scene; images are a maybe. */
export function isCertainDiagramFile(file: { name: string; type: string }): boolean {
  return file.name.toLowerCase().endsWith(DIAGRAM.ext) || file.type === DIAGRAM.mime
}

/**
 * Both of Excalidraw's "embed scene" formats stamp the payload with the same
 * marker — a PNG `tEXt` chunk keyed `application/vnd.excalidraw+json`, and an
 * SVG `<!-- payload-type:application/vnd.excalidraw+json -->` comment — so one
 * substring search over the raw bytes answers "is there a scene in here?"
 * without loading a megabyte of editor to find out.
 */
const EMBED_MARKER = DIAGRAM.mime

/**
 * How much of a dropped file the marker search looks at, from each end. PNG
 * writes its `tEXt` chunk just after the header and SVG writes its comment near
 * the end, so both ends are covered; a 40 MB image dropped by mistake costs two
 * quick scans instead of decoding 40 MB into a JS string (which is what
 * `TextDecoder('latin1').decode(whole file)` used to do — 80 MB of UTF-16 and a
 * visible hitch, for a file that is usually not a diagram at all).
 */
const SNIFF_WINDOW = 256 * 1024

/** ASCII marker search over raw bytes — no decoding, no allocation. */
export function bytesIncludeMarker(bytes: Uint8Array, marker: string, window = SNIFF_WINDOW): boolean {
  const needle = new Uint8Array(marker.length)
  for (let i = 0; i < marker.length; i++) needle[i] = marker.charCodeAt(i) & 0xff
  if (needle.length === 0 || bytes.length < needle.length) return false
  if (bytes.length <= window * 2) return findBytes(bytes, needle, 0, bytes.length)
  // Each window is widened by the marker length so one lying across the edge is
  // still found.
  return (
    findBytes(bytes, needle, 0, window + needle.length) ||
    findBytes(bytes, needle, bytes.length - window - needle.length, bytes.length)
  )
}

function findBytes(hay: Uint8Array, needle: Uint8Array, from: number, to: number): boolean {
  const first = needle[0]
  const last = Math.min(to, hay.length) - needle.length
  for (let i = Math.max(0, from); i <= last; i++) {
    if (hay[i] !== first) continue
    let j = 1
    while (j < needle.length && hay[i + j] === needle[j]) j++
    if (j === needle.length) return true
  }
  return false
}

/**
 * Decide what a dropped file is, and hand back the bytes the editor needs.
 * Returns null for anything that is not a diagram, which is the signal to fall
 * through to the ordinary "share this file" path.
 */
export async function sniffDroppedDiagram(file: File): Promise<{ name: string; base64: string } | null> {
  if (!looksLikeDiagramFile(file)) return null
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (isCertainDiagramFile(file)) {
    // A .excalidraw that isn't a scene is a broken file, not an attachment.
    const text = new TextDecoder().decode(bytes.subarray(0, 4096))
    if (!text.includes('"type"') || !text.includes('excalidraw')) return null
    return { name: file.name, base64: bytesToBase64(bytes) }
  }
  if (!bytesIncludeMarker(bytes, EMBED_MARKER)) return null
  return { name: file.name, base64: bytesToBase64(bytes) }
}

// ---------------------------------------------------------------------------
// Blob-backed scenes

/**
 * Pull a blob-backed scene through the blob service. `null` means the 7-day
 * media sweep has taken it, which the tile shows as the standard "cleaned up"
 * state — the one case where a diagram legitimately has no drawing left.
 *
 * Lives here rather than in the tile so it can be tested at all: the tile is
 * .tsx and vitest here is node-only.
 */
export async function fetchBlobScene(att: Attachment | undefined): Promise<string | null> {
  if (!att) return null
  const state = await window.bridge.files.fetchBlob(att.blobId, att.key, att.name, att.size)
  if (state.state === 'expired') return null
  const res = await fetch(blobUrl(att))
  if (!res.ok) return null
  return res.text()
}

// ---------------------------------------------------------------------------
// Change detection

/**
 * A fingerprint of the element array, for "is this diagram actually modified?".
 *
 * Excalidraw's `onChange` fires for everything — a pan, a zoom, picking a tool,
 * moving the pointer with a tool armed — so treating any call as an edit made
 * closing an untouched diagram prompt for confirmation. Element count plus
 * every element's `version`/`versionNonce` changes on a real edit and on
 * nothing else. O(n) per call, over an array capped at a few thousand.
 */
export function sceneSignature(elements: readonly { version?: number; versionNonce?: number }[]): string {
  let acc = 0
  for (const el of elements) acc = (Math.imul(acc, 31) + (((el?.version ?? 0) ^ (el?.versionNonce ?? 0)) | 0)) >>> 0
  return `${elements.length}:${acc}`
}
