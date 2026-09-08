import { net } from 'electron'
import type { LinkPreview } from '@shared/types'
import { LINKPREVIEW } from '@shared/constants'

// Sender-side link metadata fetch. On restricted networks this fails fast and
// returns { failed: true } — the message then carries an honest degraded card,
// and any teammate whose network CAN fetch may attach a preview later via a
// `prv` event.

const domainFailures = new Map<string, number>() // hostname -> failedAt

export async function fetchLinkPreview(url: string): Promise<LinkPreview> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { url, domain: url, failed: true }
  }
  const domain = parsed.hostname
  const base: LinkPreview = { url, domain }

  const lastFail = domainFailures.get(domain)
  if (lastFail && Date.now() - lastFail < LINKPREVIEW.domainFailureCacheMs) {
    return { ...base, failed: true }
  }

  try {
    const html = await fetchText(url, LINKPREVIEW.fetchTimeoutMs)
    if (html === null) throw new Error('fetch failed')
    const meta = parseOg(html)
    const preview: LinkPreview = {
      ...base,
      title: meta.title,
      desc: meta.desc,
    }
    if (meta.image) {
      const img = await fetchImageAsDataUri(new URL(meta.image, url).toString())
      if (img) preview.img = img
    }
    if (!preview.title && !preview.img) return { ...base, failed: true }
    return preview
  } catch {
    domainFailures.set(domain, Date.now())
    return { ...base, failed: true }
  }
}

function fetchText(url: string, timeoutMs: number, redirects = 0): Promise<string | null> {
  return new Promise((resolve) => {
    const req = net.request({ url, redirect: 'follow' })
    const timer = setTimeout(() => {
      req.abort()
      resolve(null)
    }, timeoutMs)
    const chunks: Buffer[] = []
    let total = 0
    req.on('response', (res) => {
      if ((res.statusCode ?? 500) >= 400) {
        clearTimeout(timer)
        resolve(null)
        return
      }
      res.on('data', (c: Buffer) => {
        total += c.length
        if (total > 512 * 1024) {
          clearTimeout(timer)
          req.abort()
          resolve(Buffer.concat(chunks).toString('utf8')) // head is enough for og tags
          return
        }
        chunks.push(c)
      })
      res.on('end', () => {
        clearTimeout(timer)
        resolve(Buffer.concat(chunks).toString('utf8'))
      })
      res.on('error', () => {
        clearTimeout(timer)
        resolve(null)
      })
    })
    req.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    req.end()
    void redirects
  })
}

function fetchBinary(url: string, timeoutMs: number, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const req = net.request({ url, redirect: 'follow' })
    const timer = setTimeout(() => {
      req.abort()
      resolve(null)
    }, timeoutMs)
    const chunks: Buffer[] = []
    let total = 0
    req.on('response', (res) => {
      if ((res.statusCode ?? 500) >= 400) {
        clearTimeout(timer)
        resolve(null)
        return
      }
      res.on('data', (c: Buffer) => {
        total += c.length
        if (total > maxBytes) {
          clearTimeout(timer)
          req.abort()
          resolve(null)
          return
        }
        chunks.push(c)
      })
      res.on('end', () => {
        clearTimeout(timer)
        resolve(Buffer.concat(chunks))
      })
      res.on('error', () => {
        clearTimeout(timer)
        resolve(null)
      })
    })
    req.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    req.end()
  })
}

async function fetchImageAsDataUri(url: string): Promise<string | null> {
  const buf = await fetchBinary(url, LINKPREVIEW.fetchTimeoutMs, LINKPREVIEW.maxImageBytes)
  if (!buf) return null
  // Keep the embedded copy tiny; if the source is already small enough, embed
  // as-is (renderer scales). Otherwise skip — the card renders without image.
  if (buf.length > LINKPREVIEW.maxEmbeddedImageBytes) return null
  const mime = sniffImageMime(buf)
  if (!mime) return null
  return `data:${mime};base64,${buf.toString('base64')}`
}

function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf.subarray(0, 4).toString() === 'GIF8') return 'image/gif'
  if (buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  return null
}

function parseOg(html: string): { title?: string; desc?: string; image?: string } {
  const head = html.slice(0, 200_000)
  const grab = (prop: string): string | undefined => {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`,
      'i',
    )
    const m = re.exec(head)
    return decodeEntities(m?.[1] ?? m?.[2])
  }
  const title = grab('og:title') ?? grab('twitter:title') ?? /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1]?.trim()
  return {
    title: title || undefined,
    desc: grab('og:description') ?? grab('description'),
    image: grab('og:image') ?? grab('twitter:image'),
  }
}

function decodeEntities(s: string | undefined): string | undefined {
  if (!s) return undefined
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
}
