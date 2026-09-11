// Scene codec: an .excalidraw JSON document <-> the compact string that rides
// inside a message event (`DiagramBody.data`).
//
// deflate-raw + base64. Raw deflate rather than gzip because the 10-byte gzip
// header buys nothing here (the format is already pinned by `DiagramBody.fmt`)
// and every byte counts against DIAGRAM.maxInlineBytes. Excalidraw scenes are
// pretty-printed JSON with hundreds of repeated key names, so they compress
// 8-12x — which is what makes the inline path viable at all.
//
// CompressionStream is a platform API in both the renderer (Chromium) and Node
// 18+, so this file and its tests need neither a dependency nor a DOM.

const CHUNK = 0x8000

function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(out)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Deflate is a compression bomb waiting to happen: 120 KB of `DiagramBody.data`
 * — the most a message may legally carry inline — inflates to ~32 MB of JSON at
 * the ratio a scene of repeated whitespace reaches (257x, measured), and a
 * hand-made 256 KB event doubles that again. Nothing here ever needs to see
 * more than this: a scene that big is not a drawing.
 */
export const MAX_DECODED_BYTES = 8 * 1024 * 1024

/** Thrown past the `catch` around the stream, which would otherwise report "not deflate-raw". */
const TOO_LARGE = 'diagram-decode: scene too large'

// CompressionStream's `writable` is typed as WritableStream<BufferSource>,
// which is not assignable to TransformStream<Uint8Array, Uint8Array> — hence
// the ReadableStream-level plumbing rather than a typed pipeThrough.
async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const src = new Blob([bytes as BlobPart]).stream() as unknown as ReadableStream<BufferSource>
  const out = src.pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, BufferSource>)
  const buf = await new Response(out as unknown as BodyInit).arrayBuffer()
  return new Uint8Array(buf)
}

/**
 * Same plumbing, but reading chunk by chunk with a running total so the ceiling
 * is enforced *while* inflating — waiting for the whole stream and measuring
 * afterwards is exactly the allocation this is meant to prevent. Cancelling the
 * reader stops the inflater at the chunk that crossed the line.
 */
async function inflateBounded(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const src = new Blob([bytes as BlobPart]).stream() as unknown as ReadableStream<BufferSource>
  const out = src.pipeThrough(
    new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, BufferSource>,
  )
  const reader = (out as unknown as ReadableStream<Uint8Array>).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error(TOO_LARGE)
    }
    chunks.push(value)
  }
  const all = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return all
}

/** Compress an .excalidraw JSON document into `DiagramBody.data`. */
export async function encodeScene(json: string): Promise<string> {
  const bytes = new TextEncoder().encode(json)
  return bytesToBase64(await through(bytes, new CompressionStream('deflate-raw')))
}

/**
 * Inflate `DiagramBody.data` back into the JSON document.
 * Throws on anything that isn't a scene this codec produced — a caller showing
 * a tile treats that as "this message is damaged", never as an empty canvas —
 * and on anything that inflates past `MAX_DECODED_BYTES`.
 */
export async function decodeScene(data: string): Promise<string> {
  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(data)
  } catch {
    throw new Error('diagram-decode: not base64')
  }
  let out: Uint8Array
  try {
    out = await inflateBounded(bytes, MAX_DECODED_BYTES)
  } catch (err) {
    if (err instanceof Error && err.message === TOO_LARGE) throw err
    throw new Error('diagram-decode: not deflate-raw')
  }
  const json = new TextDecoder().decode(out)
  if (!json.trimStart().startsWith('{')) throw new Error('diagram-decode: not JSON')
  return json
}

/** Compressed size without keeping the string around — for the inline/blob decision. */
export async function encodedLength(json: string): Promise<number> {
  return (await encodeScene(json)).length
}
