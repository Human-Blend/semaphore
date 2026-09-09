import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// The one thing this module needs from Electron is net.request, including the
// part that bites: it throws *synchronously* on any scheme but http(s)
// ("ClientRequest only supports http: and https: protocols"), which inside a
// Promise executor comes back as a rejection rather than a null.

type Reply = { status: number; body: string } | 'network'

const requested: string[] = []
let reply: (url: string) => Reply = () => 'network'

vi.mock('electron', () => ({
  net: {
    request: ({ url }: { url: string }) => {
      const p = new URL(url).protocol
      if (p !== 'http:' && p !== 'https:') throw new Error('ClientRequest only supports http: and https: protocols')
      requested.push(url)
      const req = new EventEmitter() as EventEmitter & { end(): void; abort(): void }
      req.abort = (): void => {}
      req.end = (): void => {
        // listeners are attached after request(), so answer a turn later
        queueMicrotask(() => {
          const r = reply(url)
          if (r === 'network') {
            req.emit('error', new Error('ENOTFOUND'))
            return
          }
          const res = new EventEmitter() as EventEmitter & { statusCode: number }
          res.statusCode = r.status
          req.emit('response', res)
          queueMicrotask(() => {
            res.emit('data', Buffer.from(r.body))
            res.emit('end')
          })
        })
      }
      return req
    },
  },
}))

const page = (image: string): string =>
  `<html><head><meta property="og:title" content="The Deploy Guide">` +
  `<meta property="og:description" content="How we ship.">` +
  `<meta property="og:image" content="${image}"></head><body>hi</body></html>`

// A fresh module each time: the domain-failure cache is module state.
async function load(): Promise<typeof import('./linkPreview')> {
  vi.resetModules()
  requested.length = 0
  return import('./linkPreview')
}

let fetchLinkPreview: (url: string) => Promise<import('@shared/types').LinkPreview>
beforeEach(async () => {
  ;({ fetchLinkPreview } = await load())
})

describe('a page that answered, with an og:image we cannot fetch', () => {
  it('keeps the card and leaves the rest of the domain alone (data: image)', async () => {
    reply = () => ({ status: 200, body: page('data:image/png;base64,iVBORw0KGgo=') })

    const first = await fetchLinkPreview('https://docs.example.com/guide')
    expect(first.failed).toBeUndefined()
    expect(first.title).toBe('The Deploy Guide')
    expect(first.img).toBeUndefined()

    // The host is not blacklisted: the next link to it is really fetched.
    const second = await fetchLinkPreview('https://docs.example.com/other')
    expect(second.title).toBe('The Deploy Guide')
    expect(requested).toEqual(['https://docs.example.com/guide', 'https://docs.example.com/other'])
  })

  it('keeps the card when og:image is malformed', async () => {
    reply = () => ({ status: 200, body: page('http://') })
    const p = await fetchLinkPreview('https://docs.example.com/guide')
    expect(p.failed).toBeUndefined()
    expect(p.title).toBe('The Deploy Guide')
    expect(p.img).toBeUndefined()
  })
})

describe('failures that are the network', () => {
  it('silences the domain for the cache window', async () => {
    reply = () => 'network'
    const first = await fetchLinkPreview('https://offline.example.com/a')
    expect(first).toMatchObject({ failed: true, reason: 'network' })

    const second = await fetchLinkPreview('https://offline.example.com/b')
    expect(second).toMatchObject({ failed: true, reason: 'network' })
    expect(requested).toEqual(['https://offline.example.com/a']) // b never left
  })

  it('an HTTP error does not: the host answered', async () => {
    reply = () => ({ status: 404, body: '' })
    expect(await fetchLinkPreview('https://docs.example.com/gone')).toMatchObject({ failed: true, reason: 'http' })
    reply = () => ({ status: 200, body: page('') })
    expect((await fetchLinkPreview('https://docs.example.com/here')).title).toBe('The Deploy Guide')
  })
})

it('never hands net.request a scheme it cannot speak', async () => {
  reply = () => ({ status: 200, body: page('') })
  expect(await fetchLinkPreview('file:///etc/hosts')).toMatchObject({ failed: true })
  expect(requested).toEqual([])
})
