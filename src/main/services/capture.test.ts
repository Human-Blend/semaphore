import { describe, expect, it, vi } from 'vitest'

// capture.ts imports electron eagerly (desktopCapturer/screen/session/shell/
// systemPreferences) even though orderSources() itself is pure — stub the
// module so it can be imported under vitest's node environment without a
// running Electron process.
vi.mock('electron', () => ({
  desktopCapturer: { getSources: () => Promise.reject(new Error('not used in this test')) },
  screen: { getPrimaryDisplay: () => ({ id: 0 }) },
  session: { defaultSession: { setDisplayMediaRequestHandler: () => {} } },
  shell: { openExternal: () => Promise.resolve() },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
}))

const { orderSources } = await import('./capture')

// 1.2: the picker used to start with nothing selected, and on macOS without
// the Screen Recording grant the "screen" source enumerated fine (just showing
// wallpaper + Chat's own windows) — so nothing ever nudged people toward
// actually picking a real screen. The fix pre-selects the primary display,
// which depends entirely on this ordering/flagging being right.
describe('orderSources', () => {
  const screenSrc = (id: string, displayId: string) => ({ id, kind: 'screen' as const, displayId })
  const windowSrc = (id: string) => ({ id, kind: 'window' as const, displayId: '' })

  it('puts all screens before all windows', () => {
    const out = orderSources([windowSrc('window:1:0'), screenSrc('screen:1:0', '1'), windowSrc('window:2:0')], '1')
    expect(out.map((s) => s.kind)).toEqual(['screen', 'window', 'window'])
  })

  it('flags the display matching screen.getPrimaryDisplay().id as primary and sorts it first', () => {
    const out = orderSources([screenSrc('screen:2:0', '222'), screenSrc('screen:1:0', '111')], '111')
    expect(out[0]).toMatchObject({ id: 'screen:1:0', primary: true })
    expect(out[1].id).toBe('screen:2:0')
    expect(out[1].primary).toBeUndefined()
  })

  it('falls back to flagging the lone screen as primary when display_id is unavailable', () => {
    const out = orderSources([screenSrc('screen:1:0', '')], '')
    expect(out[0]).toMatchObject({ id: 'screen:1:0', primary: true })
  })

  it('flags no primary when there are multiple screens and none match display_id', () => {
    const out = orderSources([screenSrc('screen:1:0', ''), screenSrc('screen:2:0', '')], '999')
    expect(out.some((s) => s.primary)).toBe(false)
    expect(out.map((s) => s.id)).toEqual(['screen:1:0', 'screen:2:0']) // unmatched: no reorder either
  })

  it('leaves screen and window relative order alone beyond the screens-first / primary-first rules', () => {
    const out = orderSources(
      [windowSrc('window:5:0'), windowSrc('window:6:0'), screenSrc('screen:1:0', '1'), screenSrc('screen:2:0', '2')],
      'no-match',
    )
    expect(out.map((s) => s.id)).toEqual(['screen:1:0', 'screen:2:0', 'window:5:0', 'window:6:0'])
  })
})
