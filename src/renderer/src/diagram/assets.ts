// Where Excalidraw finds its fonts.
//
// The library resolves every font URI ("./fonts/Excalifont/…woff2") against
// `window.EXCALIDRAW_ASSET_PATH`, and when that is unset it falls back to
// `https://esm.sh/@excalidraw/excalidraw@<version>/dist/prod/` — a CDN the
// renderer's CSP blocks and the deployments this app targets can't reach.
// Without the fonts the hand-drawn look is gone from the canvas *and* from
// every PNG/SVG export, so this is not decoration: it is the feature working.
//
// The value must be an ABSOLUTE url. Excalidraw's `normalizeBaseUrl` resolves a
// path that starts with `/` or `./` against `window.location.origin`, and for a
// packaged build that origin is the string "file://" — which would send it to
// the filesystem root. Resolving against `location.href` here gets it right in
// both worlds: http://localhost:<port>/excalidraw-assets/ in dev,
// file:///…/out/renderer/excalidraw-assets/ in a build.
//
// `scripts/sync-excalidraw-assets.mjs` puts the files there.
//
// IMPORTANT: importing this module is what arms the path, and it has to happen
// in a chunk that is evaluated BEFORE Excalidraw's. A side-effect import at the
// top of the lazy editor is NOT enough: ESM evaluates a chunk's imports before
// its own body, so Excalidraw's font registry is already built by the time that
// line runs, and every FontFace ends up carrying only the esm.sh fallback the
// CSP blocks. DiagramRoot (which the app shell imports at startup) is the one
// that arms it; the editor and the tile renderer import it too, harmlessly, so
// the dependency is visible where it matters.

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[]
  }
}

export function excalidrawAssetPath(): string {
  return new URL('excalidraw-assets/', window.location.href).toString()
}

/** The CDN Excalidraw appends to every font's `src` list, no matter what we set. */
const FALLBACK_HOST = 'esm.sh'

/**
 * Families `scripts/sync-excalidraw-assets.mjs` deliberately does NOT copy, and
 * which therefore are not on disk at `EXCALIDRAW_ASSET_PATH`.
 *
 * Xiaolai is Excalidraw's CJK fallback: 12 MB of the 13 MB font set, for glyphs
 * this team never types (see SKIP_FAMILIES in that script — keep the two in
 * step). Chromium only fetches a face when a character in its unicode-range is
 * actually rendered, so nothing asks for these on open; but the first time
 * someone pastes CJK text the faces would 404 in a build and fail noisily in
 * dev. Pointing them at `local()` instead means the browser looks for a system
 * copy and, not finding one, falls through to its own CJK fallback — the same
 * pixels, minus the failed requests.
 */
const MISSING_FAMILIES = ['Xiaolai']

/** `url(…/fonts/Xiaolai/Xiaolai-Regular-….woff2)` → which family is this source? */
function missingFamilyOf(part: string): string | undefined {
  return MISSING_FAMILIES.find((f) => part.includes(`/${f}/`) || part.includes(`\\${f}\\`))
}

/**
 * Drop the CDN half of a font's `src` list.
 *
 * Excalidraw's `createUrls` ALWAYS appends its esm.sh fallback after whatever
 * `EXCALIDRAW_ASSET_PATH` yields, so every face ends up as
 * `url(file://…/Excalifont.woff2) format('woff2'), url(https://esm.sh/…)`.
 * Chromium loads the local file (the glyphs really do come from disk — measured)
 * but *also* issues a request for the second source, which the CSP then blocks:
 * ~230 "Refused to load the font" lines in the console every time the editor
 * opens, and 230 requests that a real office network would leave hanging.
 *
 * There is no prop or global that removes the fallback, so it is removed here,
 * on the way into the platform API: any `url(...)` segment pointing at the CDN
 * is dropped, and if that would leave nothing, the original string is kept
 * (better a blocked request than a missing font). Sources for a family the
 * sync script never copied (`MISSING_FAMILIES`) go the same way, and those DO
 * leave nothing — so the face is pointed at a `local()` copy instead of a URL
 * that cannot resolve. Everything else — including this app's own FontFace use
 * — passes through untouched.
 */
function stripCdnSources(src: string): string {
  const parts = src.split(/,(?![^(]*\))/)
  let missing: string | undefined
  const kept = parts.filter((part) => {
    if (part.includes(FALLBACK_HOST)) return false
    const family = missingFamilyOf(part)
    if (family) {
      missing = family
      return false
    }
    return true
  })
  if (kept.length === parts.length) return src
  const out = kept.join(',').trim()
  if (out) return out
  // Nothing left: a family that was never synced (ask the system for it, which
  // costs no request), or — if it was only the CDN — better a blocked request
  // than a font with no sources at all.
  return missing ? `local("${missing}")` : src
}

function installFontFaceFilter(): void {
  const Original = window.FontFace
  if (typeof Original !== 'function' || (Original as { __sfPatched?: true }).__sfPatched) return
  const Patched = new Proxy(Original, {
    construct(target, args: unknown[], newTarget) {
      if (typeof args[1] === 'string') args[1] = stripCdnSources(args[1])
      return Reflect.construct(target, args, newTarget) as object
    },
  })
  ;(Patched as unknown as { __sfPatched: true }).__sfPatched = true
  window.FontFace = Patched
}

if (typeof window !== 'undefined') {
  window.EXCALIDRAW_ASSET_PATH = excalidrawAssetPath()
  installFontFaceFilter()
}

export { stripCdnSources }
