import { describe, expect, it } from 'vitest'
import { isSameDocument } from './navGuard'

// The rule the main window's `will-navigate` guard applies. Everything that is
// not the app's own document is refused (and handed to the OS browser if it is
// http(s)) — because the renderer has the preload bridge attached, so a page
// that is not ours must never be the page in that window.

const PACKAGED = 'file:///Applications/Chat.app/Contents/Resources/app/out/renderer/index.html'
const DEV = 'http://localhost:5173/'

describe('isSameDocument — packaged (file://)', () => {
  it('allows a reload of the very same document', () => {
    expect(isSameDocument(PACKAGED, PACKAGED)).toBe(true)
    expect(isSameDocument(`${PACKAGED}?x=1`, PACKAGED)).toBe(true)
  })

  it('refuses another file on disk', () => {
    expect(isSameDocument('file:///etc/passwd', PACKAGED)).toBe(false)
    expect(isSameDocument('file:///Applications/Chat.app/Contents/Resources/app/out/renderer/other.html', PACKAGED)).toBe(
      false,
    )
  })

  it('refuses the web, which is what an SVG <a href> in a peer’s diagram would be', () => {
    expect(isSameDocument('https://evil.example/pwn', PACKAGED)).toBe(false)
    expect(isSameDocument('http://evil.example/pwn', PACKAGED)).toBe(false)
  })

  it('refuses the other schemes a link can carry', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'about:blank',
      'chrome://settings',
      'sfblob://blob/deadbeef',
      'mailto:someone@example.com',
    ]) {
      expect(isSameDocument(url, PACKAGED)).toBe(false)
    }
  })
})

describe('isSameDocument — dev server (http://localhost)', () => {
  it('allows the dev server’s own pages, so HMR keeps working', () => {
    expect(isSameDocument(DEV, DEV)).toBe(true)
    expect(isSameDocument('http://localhost:5173/index.html', DEV)).toBe(true)
  })

  it('refuses another origin, including the same host on another port', () => {
    expect(isSameDocument('http://localhost:9999/', DEV)).toBe(false)
    expect(isSameDocument('https://localhost:5173/', DEV)).toBe(false)
    expect(isSameDocument('https://evil.example/', DEV)).toBe(false)
  })
})

describe('isSameDocument — nonsense', () => {
  it('refuses anything that is not a URL at all', () => {
    expect(isSameDocument('not a url', PACKAGED)).toBe(false)
    expect(isSameDocument('', PACKAGED)).toBe(false)
    expect(isSameDocument(PACKAGED, '')).toBe(false)
  })
})
