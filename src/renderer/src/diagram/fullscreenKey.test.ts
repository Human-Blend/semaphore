import { describe, expect, it } from 'vitest'
import { fullScreenKeyLabel, isFullScreenToggleKey } from './fullscreenKey'

function key(k: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>) {
  return { key: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...k }
}

describe('isFullScreenToggleKey', () => {
  it('macOS: Control+Command+F toggles', () => {
    expect(isFullScreenToggleKey(key({ key: 'f', ctrlKey: true, metaKey: true }), 'darwin')).toBe(true)
    expect(isFullScreenToggleKey(key({ key: 'F', ctrlKey: true, metaKey: true }), 'darwin')).toBe(true)
  })

  it('macOS: Command alone or Control alone does not toggle', () => {
    expect(isFullScreenToggleKey(key({ key: 'f', metaKey: true }), 'darwin')).toBe(false)
    expect(isFullScreenToggleKey(key({ key: 'f', ctrlKey: true }), 'darwin')).toBe(false)
  })

  it('macOS: F11 does not toggle (reserved for Show Desktop)', () => {
    expect(isFullScreenToggleKey(key({ key: 'F11' }), 'darwin')).toBe(false)
  })

  it('Windows/Linux: bare F11 toggles', () => {
    expect(isFullScreenToggleKey(key({ key: 'F11' }), 'win32')).toBe(true)
    expect(isFullScreenToggleKey(key({ key: 'F11' }), 'linux')).toBe(true)
  })

  it('Windows: F11 with a modifier held does not toggle', () => {
    expect(isFullScreenToggleKey(key({ key: 'F11', ctrlKey: true }), 'win32')).toBe(false)
    expect(isFullScreenToggleKey(key({ key: 'F11', metaKey: true }), 'win32')).toBe(false)
  })

  it('Windows: ⌃⌘F chord (no F11) does not toggle', () => {
    expect(isFullScreenToggleKey(key({ key: 'f', ctrlKey: true, metaKey: true }), 'win32')).toBe(false)
  })

  it('Shift or Alt held rules out the chord on either platform', () => {
    expect(isFullScreenToggleKey(key({ key: 'f', ctrlKey: true, metaKey: true, shiftKey: true }), 'darwin')).toBe(false)
    expect(isFullScreenToggleKey(key({ key: 'F11', altKey: true }), 'win32')).toBe(false)
  })
})

describe('fullScreenKeyLabel', () => {
  it('is the platform-appropriate shortcut label', () => {
    expect(fullScreenKeyLabel('darwin')).toBe('⌃⌘F')
    expect(fullScreenKeyLabel('win32')).toBe('F11')
    expect(fullScreenKeyLabel('linux')).toBe('F11')
  })
})
