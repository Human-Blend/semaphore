import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IoTier } from './ioTier'

// When the file/beam services are built, and what happens to them when the
// session underneath goes away (changeTeamFolder, a lock).
//
// Wiring is driven by `controller.onSessionChange` — synchronous with the
// session appearing, because the sfblob:// protocol handler is wired there and
// the renderer starts asking for images the moment it hears "ready" — with the
// old 1 s poll against `controller.chat` kept behind it as a backstop. That
// poll used to tear the old services down only when a *replacement*
// ChatService appeared, so between leaving one team folder and joining the
// next, the previous drops poller kept scanning the old share and the previous
// tier subscription kept feeding it.
//
// The services themselves are stubbed: the question here is lifecycle, not
// blobs or beams.

const spy = vi.hoisted(() => ({ starts: 0, stops: 0, tiers: [] as string[] }))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  dialog: {},
  ipcMain: { handle: () => {} },
}))

vi.mock('./blobs', () => ({
  BlobService: class {
    initProtocol(): void {}
    upload(): void {}
  },
  mimeForName: () => 'application/octet-stream',
  sanitizeFileName: (n: string) => n,
}))

vi.mock('./drops', () => ({
  DropService: class {
    start(): void {
      spy.starts++
    }
    stop(): void {
      spy.stops++
    }
    setTier(tier: string): void {
      spy.tiers.push(tier)
    }
    noteHint(): void {}
  },
}))

vi.mock('./staging', () => ({
  discardStaged: async () => true,
  isStagedPath: () => false,
  stagingRoot: () => '/tmp/staging',
  sweepStaging: async () => 0,
}))

const { registerFileIpc } = await import('./filesIpc')

/** An AppController with just the members the file IPC slice reads. */
function controllerStub() {
  let listeners: ((tier: IoTier, idleSec: number) => void)[] = []
  let sessionListeners: (() => void)[] = []
  const counts = { subscribed: 0, unsubscribed: 0 }
  const controller = {
    chat: null as unknown,
    getSettings: () => ({}),
    onSessionChange(fn: () => void) {
      sessionListeners.push(fn)
      return () => {
        sessionListeners = sessionListeners.filter((l) => l !== fn)
      }
    },
    ioTier: {
      onChange(cb: (tier: IoTier, idleSec: number) => void) {
        counts.subscribed++
        listeners.push(cb)
        cb('blurred', 0) // the manager replays the current tier to newcomers
        return () => {
          counts.unsubscribed++
          listeners = listeners.filter((l) => l !== cb)
        }
      },
    },
  }
  return {
    controller,
    counts,
    emit(tier: IoTier) {
      for (const l of [...listeners]) l(tier, 0)
    },
    /** What AppController.startSession / changeTeamFolder do, without a timer. */
    session(chat: unknown) {
      controller.chat = chat
      for (const l of [...sessionListeners]) l()
    },
    live: () => listeners.length,
  }
}

const fakeChat = (): unknown => ({
  attachmentUploader: null,
  dropHintHandler: null,
  xferHandler: null,
})

beforeEach(() => {
  spy.starts = 0
  spy.stops = 0
  spy.tiers = []
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('file IPC service lifecycle', () => {
  it('wires the services on the session hook, without waiting for the poll', () => {
    // The bug this covers: the renderer paints the cached timeline the moment
    // the ready `boot` push lands, and every sfblob:// image it asks for before
    // BlobService.initProtocol() has run got a 503 it never retried. The hook
    // fires inside startSession, so there is no window to lose.
    const rig = controllerStub()
    registerFileIpc(rig.controller as never, () => null)

    rig.session(fakeChat())
    expect(spy.starts).toBe(1) // no timer has advanced at all
    expect(rig.counts.subscribed).toBe(1)

    // And the poll behind it does not wire a second set.
    vi.advanceTimersByTime(3000)
    expect(spy.starts).toBe(1)
  })

  it('drops them on the same hook when the team folder changes', () => {
    const rig = controllerStub()
    registerFileIpc(rig.controller as never, () => null)

    rig.session(fakeChat())
    rig.session(null) // changeTeamFolder nulls chat, then fires the hook
    expect(spy.stops).toBe(1)
    expect(rig.counts.unsubscribed).toBe(1)
    expect(rig.live()).toBe(0)

    rig.session(fakeChat()) // the new folder
    expect(spy.starts).toBe(2)
    expect(spy.stops).toBe(1)
  })

  it('stops the drops poller and drops the tier subscription when the session goes away', () => {
    const rig = controllerStub()
    registerFileIpc(rig.controller as never, () => null)

    rig.controller.chat = fakeChat()
    vi.advanceTimersByTime(1000)
    expect(spy.starts).toBe(1)
    expect(rig.counts.subscribed).toBe(1)
    expect(spy.tiers).toEqual(['blurred'])

    // changeTeamFolder: chat is null for as long as onboarding takes.
    rig.controller.chat = null
    vi.advanceTimersByTime(1000)
    expect(spy.stops).toBe(1)
    expect(rig.counts.unsubscribed).toBe(1)
    expect(rig.live()).toBe(0)

    // A tier change in that window must not reach the stopped service.
    rig.emit('idle')
    expect(spy.tiers).toEqual(['blurred'])

    // Still nothing, poll after poll, until a session exists again.
    vi.advanceTimersByTime(5000)
    expect(spy.stops).toBe(1)
    expect(spy.starts).toBe(1)
  })

  it('wires exactly one set of services per session, and swaps them on re-onboarding', () => {
    const rig = controllerStub()
    registerFileIpc(rig.controller as never, () => null)

    rig.controller.chat = fakeChat()
    vi.advanceTimersByTime(3000) // three polls, one wiring
    expect(spy.starts).toBe(1)
    expect(rig.counts.subscribed).toBe(1)

    rig.controller.chat = null
    vi.advanceTimersByTime(1000)
    rig.controller.chat = fakeChat() // the new team folder
    vi.advanceTimersByTime(1000)
    expect(spy.starts).toBe(2)
    expect(spy.stops).toBe(1) // the first one, once — not twice
    expect(rig.counts.subscribed).toBe(2)
    expect(rig.counts.unsubscribed).toBe(1)
    expect(rig.live()).toBe(1) // exactly one subscriber, the new one

    rig.emit('focused')
    expect(spy.tiers).toEqual(['blurred', 'blurred', 'focused'])
  })
})
