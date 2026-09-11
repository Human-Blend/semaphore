import { describe, expect, it } from 'vitest'
import { allScreensLookBlank, looksBlankThumbnail, presenterLabel, resolveSourceKind, shouldShowPermissionPanel } from './manager'

// Fixed-content base64 data URL of approximately `byteLength` decoded bytes —
// content doesn't matter, only length, since looksBlankThumbnail is a
// compressed-size heuristic (there's no image decoder available: zero native
// modules, per CLAUDE.md).
function fakeThumb(byteLength: number): string {
  const chars = Math.ceil(byteLength / 3) * 4
  return `data:image/png;base64,${'A'.repeat(chars)}`
}

describe('looksBlankThumbnail', () => {
  it('treats a small (uniform-color) capture as blank', () => {
    expect(looksBlankThumbnail(fakeThumb(200))).toBe(true)
  })

  it('treats a normal-sized desktop/window capture as not blank', () => {
    expect(looksBlankThumbnail(fakeThumb(8_000))).toBe(false)
  })
})

describe('allScreensLookBlank', () => {
  it('is true only when every screen source looks blank', () => {
    const blank = { kind: 'screen' as const, thumbnailDataUrl: fakeThumb(100) }
    const real = { kind: 'screen' as const, thumbnailDataUrl: fakeThumb(9_000) }
    expect(allScreensLookBlank([blank, blank])).toBe(true)
    expect(allScreensLookBlank([blank, real])).toBe(false)
  })

  it('ignores window sources and is false when there are no screens at all', () => {
    const blankWindow = { kind: 'window' as const, thumbnailDataUrl: fakeThumb(100) }
    expect(allScreensLookBlank([blankWindow])).toBe(false)
  })
})

// The permission panel must never gate on permission status BEFORE a capture
// attempt (CLAUDE.md) — this decision only ever runs after listSources() has
// already run, and only on macOS, where Screen Recording is a thing at all.
describe('shouldShowPermissionPanel', () => {
  const realScreen = { kind: 'screen' as const, thumbnailDataUrl: fakeThumb(9_000) }
  const blankScreen = { kind: 'screen' as const, thumbnailDataUrl: fakeThumb(100) }

  it('never blocks on non-macOS, regardless of permission or thumbnails', () => {
    expect(shouldShowPermissionPanel(false, 'denied', [blankScreen])).toBe(false)
    expect(shouldShowPermissionPanel(false, 'granted', [blankScreen])).toBe(false)
  })

  it('blocks on macOS whenever permission is not granted', () => {
    expect(shouldShowPermissionPanel(true, 'denied', [realScreen])).toBe(true)
    expect(shouldShowPermissionPanel(true, 'not-determined', [realScreen])).toBe(true)
    expect(shouldShowPermissionPanel(true, 'restricted', [realScreen])).toBe(true)
  })

  it('on macOS with permission granted, blocks only if every screen thumbnail looks blank', () => {
    expect(shouldShowPermissionPanel(true, 'granted', [realScreen])).toBe(false)
    expect(shouldShowPermissionPanel(true, 'granted', [blankScreen])).toBe(true)
  })
})

describe('resolveSourceKind', () => {
  it('trusts the actual capture surface over the picked source kind', () => {
    expect(resolveSourceKind('window', 'monitor')).toBe('screen')
    expect(resolveSourceKind('screen', 'window')).toBe('window')
    expect(resolveSourceKind('screen', 'application')).toBe('window')
    expect(resolveSourceKind('screen', 'browser')).toBe('window')
  })

  it('falls back to the picked kind when the browser reports no surface', () => {
    expect(resolveSourceKind('screen', undefined)).toBe('screen')
    expect(resolveSourceKind('window', undefined)).toBe('window')
  })
})

describe('presenterLabel', () => {
  it('names screens and windows differently', () => {
    expect(presenterLabel('Display 1', 'screen')).toBe('Sharing Display 1')
    expect(presenterLabel('Xcode', 'window')).toBe('Sharing window: Xcode')
  })
})
