import { describe, expect, it } from 'vitest'
import { stripCdnSources } from './assets'

// What reaches the platform `FontFace` constructor. Two things are removed on
// the way in: Excalidraw's hardcoded esm.sh fallback (blocked by the CSP, ~230
// failed requests per editor open), and any family the asset sync deliberately
// does not copy.

const LOCAL = "url(file:///app/out/renderer/excalidraw-assets/fonts/Excalifont/Excalifont-Regular-abc.woff2) format('woff2')"
const CDN = "url(https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/fonts/Excalifont/Excalifont-Regular-abc.woff2) format('woff2')"
const XIAOLAI = "url(file:///app/out/renderer/excalidraw-assets/fonts/Xiaolai/Xiaolai-Regular-abc.woff2) format('woff2')"
const XIAOLAI_CDN = "url(https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/fonts/Xiaolai/Xiaolai-Regular-abc.woff2) format('woff2')"

describe('stripCdnSources', () => {
  it('keeps the local file and drops the CDN fallback', () => {
    expect(stripCdnSources(`${LOCAL}, ${CDN}`)).toBe(LOCAL)
  })

  it('leaves a src with no CDN in it exactly as it was', () => {
    expect(stripCdnSources(LOCAL)).toBe(LOCAL)
    expect(stripCdnSources("local('Helvetica')")).toBe("local('Helvetica')")
  })

  it('keeps a CDN-only src rather than leaving a face with no source', () => {
    expect(stripCdnSources(CDN)).toBe(CDN)
  })

  it('points a family the sync never copied at a local() lookup instead of a 404', () => {
    // Xiaolai is Excalidraw's CJK fallback — 12 MB of the 13 MB font set, and
    // skipped by scripts/sync-excalidraw-assets.mjs. Asking the filesystem for
    // it would fail; asking the system for a local copy costs no request.
    expect(stripCdnSources(`${XIAOLAI}, ${XIAOLAI_CDN}`)).toBe('local("Xiaolai")')
    expect(stripCdnSources(XIAOLAI)).toBe('local("Xiaolai")')
  })

  it('does not touch families that ARE synced', () => {
    for (const family of ['Excalifont', 'Nunito', 'Virgil', 'Assistant', 'Cascadia', 'ComicShanns', 'Liberation', 'Lilita']) {
      const src = LOCAL.replace(/Excalifont/g, family)
      expect(stripCdnSources(src)).toBe(src)
    }
  })

  it('splits on top-level commas only, so a url() with a comma survives', () => {
    const weird = "url(\"file:///app/fonts/A,B/x.woff2\") format('woff2')"
    expect(stripCdnSources(`${weird}, ${CDN}`)).toBe(weird)
  })
})
