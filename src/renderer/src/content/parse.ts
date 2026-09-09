// Pure text-segmentation helpers for message rendering. No React, no I/O —
// unit-test friendly. MessageBody composes these; nothing here touches the DOM.

import type { Attachment, BodyEntity } from '@shared/types'

export type TextPart = { kind: 'text'; text: string }
export type LinkPart = { kind: 'link'; url: string; text: string }
export type CodePart = { kind: 'code'; text: string }
export type MentionPart = { kind: 'mention'; text: string; device?: string; special?: 'here' }
export type Part = TextPart | LinkPart | CodePart | MentionPart

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi

/** Trailing punctuation that reads as prose, not as part of the URL. */
function trimUrlTail(raw: string): string {
  let url = raw
  for (;;) {
    const last = url[url.length - 1]
    if (last === undefined) break
    if ('.,;:!?\'"'.includes(last)) {
      url = url.slice(0, -1)
      continue
    }
    if (last === ')' && count(url, '(') < count(url, ')')) {
      url = url.slice(0, -1)
      continue
    }
    if (last === ']' && count(url, '[') < count(url, ']')) {
      url = url.slice(0, -1)
      continue
    }
    break
  }
  return url
}

/**
 * The same link, allowing for the prose punctuation and trailing slash the
 * two ends of the pipeline may or may not have trimmed.
 */
export function sameUrl(a: string, b: string): boolean {
  const norm = (u: string): string => trimUrlTail(u.trim()).replace(/\/+$/, '')
  return norm(a) === norm(b)
}

/** The first URL a message links (skipping code spans) — the one that gets a preview. */
export function firstLinkOf(text: string, entities?: BodyEntity[]): string | null {
  const link = segmentMessage(text, entities).find((p): p is LinkPart => p.kind === 'link')
  return link?.url ?? null
}

function count(s: string, ch: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++
  return n
}

/** Split plain text into text/link parts. Pure; deterministic. */
export function linkifyParts(text: string): (TextPart | LinkPart)[] {
  const parts: (TextPart | LinkPart)[] = []
  let cursor = 0
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(text)) !== null) {
    const url = trimUrlTail(m[0])
    if (url.length < 10) continue // "https://x" — not worth linking
    if (m.index > cursor) parts.push({ kind: 'text', text: text.slice(cursor, m.index) })
    parts.push({ kind: 'link', url, text: url })
    cursor = m.index + url.length
    URL_RE.lastIndex = cursor
  }
  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) })
  return parts
}

const INLINE_CODE_RE = /`([^`\n]+)`/g

/** Split plain text into text/inline-code parts (backtick pairs). Pure. */
export function inlineCodeParts(text: string): (TextPart | CodePart)[] {
  const parts: (TextPart | CodePart)[] = []
  let cursor = 0
  INLINE_CODE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_CODE_RE.exec(text)) !== null) {
    if (m.index > cursor) parts.push({ kind: 'text', text: text.slice(cursor, m.index) })
    parts.push({ kind: 'code', text: m[1] })
    cursor = m.index + m[0].length
  }
  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) })
  return parts
}

/**
 * Full message segmentation: mention entities (trusted offsets) are carved out
 * first; the remaining spans get inline-code, then link detection.
 */
export function segmentMessage(text: string, entities?: BodyEntity[]): Part[] {
  const mentions = (entities ?? [])
    .filter((e): e is Extract<BodyEntity, { type: 'mention' }> => e.type === 'mention')
    .filter((e) => e.start >= 0 && e.end > e.start && e.end <= text.length)
    .sort((a, b) => a.start - b.start)

  const out: Part[] = []
  let cursor = 0
  const pushPlain = (chunk: string): void => {
    for (const p of inlineCodeParts(chunk)) {
      if (p.kind === 'code') out.push(p)
      else for (const lp of linkifyParts(p.text)) out.push(lp)
    }
  }
  for (const m of mentions) {
    if (m.start < cursor) continue // overlapping entity — skip defensively
    if (m.start > cursor) pushPlain(text.slice(cursor, m.start))
    out.push({ kind: 'mention', text: text.slice(m.start, m.end), device: m.device, special: m.special })
    cursor = m.end
  }
  if (cursor < text.length) pushPlain(text.slice(cursor))
  return out
}

// ---------------------------------------------------------------------------
// Small shared formatting/lookup helpers

export function middleTruncate(s: string, max: number): string {
  if (s.length <= max) return s
  const head = Math.ceil((max - 1) * 0.6)
  const tail = max - 1 - head
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`
}

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return 'bin'
  return name.slice(dot + 1).toLowerCase().slice(0, 3)
}

export interface FileKind {
  /** CSS color for the icon tile. */
  tint: string
  family: 'doc' | 'sheet' | 'slides' | 'archive' | 'code' | 'pdf' | 'audio' | 'unknown'
}

const SHEET_EXT = new Set(['xls', 'xlsx', 'csv', 'tsv', 'numbers', 'ods'])
const DOC_EXT = new Set(['doc', 'docx', 'txt', 'md', 'rtf', 'pages', 'odt', 'tex'])
const SLIDE_EXT = new Set(['ppt', 'pptx', 'key', 'odp'])
const ARCHIVE_EXT = new Set(['zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'xz', 'bz2', 'dmg', 'iso'])
const CODE_EXT = new Set([
  'js', 'ts', 'jsx', 'tsx', 'py', 'go', 'rs', 'c', 'h', 'cpp', 'cc', 'cs', 'java', 'rb', 'php',
  'sh', 'zsh', 'bash', 'json', 'yml', 'yaml', 'toml', 'sql', 'html', 'css', 'scss', 'vue', 'svelte',
])

export function fileKindOf(name: string, mime: string): FileKind {
  const ext = extOf(name)
  if (ext === 'pdf' || mime === 'application/pdf') return { tint: 'var(--hue-0)', family: 'pdf' }
  if (SHEET_EXT.has(ext)) return { tint: 'var(--hue-3)', family: 'sheet' }
  if (SLIDE_EXT.has(ext)) return { tint: 'var(--hue-1)', family: 'slides' }
  if (ARCHIVE_EXT.has(ext)) return { tint: 'var(--hue-2)', family: 'archive' }
  if (CODE_EXT.has(ext) || mime.startsWith('text/x-')) return { tint: 'var(--accent)', family: 'code' }
  if (DOC_EXT.has(ext) || mime.startsWith('text/')) return { tint: 'var(--hue-5)', family: 'doc' }
  if (mime.startsWith('audio/')) return { tint: 'var(--hue-4)', family: 'audio' }
  return { tint: 'var(--presence-offline)', family: 'unknown' }
}

/** True when the attachment renders inline as media (image/video/gif). */
export function isMediaAttachment(att: Attachment): boolean {
  return att.mime.startsWith('image/') || att.mime.startsWith('video/')
}

/** Streaming URL for a shared blob — main process decrypts on the fly. */
export function blobUrl(att: Pick<Attachment, 'blobId' | 'key' | 'name' | 'size'>): string {
  return `sfblob://blob/${att.blobId}?key=${encodeURIComponent(att.key)}&name=${encodeURIComponent(att.name)}&size=${att.size}`
}

/** Fit media into the spec box: max 420×320, min 120×80, unknown → 320×200. */
export function fitMediaBox(w?: number, h?: number): { w: number; h: number; known: boolean } {
  if (!w || !h || w <= 0 || h <= 0) return { w: 320, h: 200, known: false }
  const scale = Math.min(420 / w, 320 / h, 1)
  return {
    w: Math.max(120, Math.round(w * scale)),
    h: Math.max(80, Math.round(h * scale)),
    known: true,
  }
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
