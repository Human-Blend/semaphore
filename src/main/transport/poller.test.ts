import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BeaconContent, PresenceView } from '@shared/types'
import type { SettingsView } from '@shared/bridge'
import { BEACON, IO_BUDGET, POLL, PRESENCE, TEAM_CONV } from '@shared/constants'
import { generateIdentity, type DeviceIdentity } from '../crypto/identity'
import type { SecretStore } from '../store/secretStore'
import { BeaconWriter, type BeaconObservation, type BeaconReader } from './beacon'
import { createOrJoinTeam } from './bootstrap'
import { EventStore } from './events'
import { Poller } from './poller'
import { Roster } from './roster'
import { Session } from './session'
import { ShareIo } from './shareIo'

// DropService (and the blob helpers it pulls in) reach for electron at call
// time only; a stub is enough to measure their share traffic.
vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.0', getPath: () => '/tmp', dock: null },
  BrowserWindow: class {},
  Notification: class {
    static isSupported(): boolean {
      return false
    }
  },
  shell: { openPath: async () => '', showItemInFolder: () => {} },
  dialog: {},
  nativeImage: { createFromDataURL: () => ({}) },
}))

// The first poll, seen from the renderer. processObservation announces every
// device it meets, and the handler in chatService turns around and pushes the
// whole presence list — so a list derived halfway through the first listing
// must not claim the teammates not reached yet are gone.

class FakeStore implements SecretStore {
  readonly unlocked = true
  private m = new Map<string, Buffer>()
  writeSecret(name: string, data: Buffer): void {
    this.m.set(name, Buffer.from(data))
  }
  readSecret(name: string): Buffer | null {
    return this.m.get(name) ?? null
  }
  writeSecretJson(name: string, value: unknown): void {
    this.writeSecret(name, Buffer.from(JSON.stringify(value)))
  }
  readSecretJson<T>(name: string): T | null {
    const b = this.readSecret(name)
    return b ? (JSON.parse(b.toString()) as T) : null
  }
  deleteSecret(name: string): void {
    this.m.delete(name)
  }
}

/** One team folder, one session for us, and a roster holding everyone named. */
async function team(names: string[]): Promise<{ session: Session; ids: Map<string, DeviceIdentity> }> {
  const io = new ShareIo(mkdtempSync(join(tmpdir(), 'sem-poller-')))
  const res = await createOrJoinTeam(io, 'correct horse battery staple', 'Test Team')
  if ('error' in res) throw new Error(res.error)
  const { proto, teamSalt, tmk } = res.join
  const mine = generateIdentity().identity
  const seed = new Session(
    io,
    new FakeStore(),
    mine,
    proto,
    teamSalt,
    tmk,
    tmk,
    new Roster(io, new FakeStore(), tmk, proto.epoch),
    'Me',
  )
  const kMeta = seed.keys.kMeta

  const ids = new Map<string, DeviceIdentity>()
  for (const name of ['Me', ...names]) {
    const identity = name === 'Me' ? mine : generateIdentity().identity
    ids.set(name, identity)
    const roster = new Roster(io, new FakeStore(), kMeta, proto.epoch)
    await roster.publishSelf(identity, {
      deviceId: identity.deviceId,
      edPub: identity.edPub,
      xPub: identity.xPub,
      displayName: name,
      hostname: `${name}-host`,
      osUser: name.toLowerCase(),
      platform: 'darwin',
      machineIdHash: null,
      firstSeen: Date.now(),
      recSeq: 1,
    })
  }

  const roster = new Roster(io, new FakeStore(), kMeta, proto.epoch)
  roster.loadPins()
  await roster.refresh()
  return { session: new Session(io, new FakeStore(), mine, proto, teamSalt, tmk, tmk, roster, 'Me'), ids }
}

interface BeaconOpts {
  /** Share-clock stamp the beacon carries (default: now). */
  stampedAt?: number
  /** When this reader got round to reading the file (default: now). */
  noticedAt?: number
  verified?: boolean
  app?: string
  idleSec?: number
  state?: BeaconContent['presence']['state']
}

function beaconOf(identity: DeviceIdentity, name: string, opts: BeaconOpts = {}): BeaconObservation {
  const now = Date.now()
  return {
    deviceId8: identity.deviceId.slice(0, 8),
    content: {
      device: identity.deviceId,
      name,
      seq: '00000001',
      hlc: opts.stampedAt ?? now,
      presence: { state: opts.state ?? 'online', status: '', idleSec: opts.idleSec ?? 0 },
      heads: {},
      cursors: {},
      app: opts.app,
    },
    verified: opts.verified ?? true,
    dmSections: new Map(),
    observedAtMono: opts.noticedAt ?? now,
  }
}

/** Hand the poller a canned listing instead of the share's beacon dir. */
function stubListing(poller: Poller, observations: BeaconObservation[]): void {
  ;(poller as unknown as { reader: Pick<BeaconReader, 'poll'> }).reader = {
    poll: () => Promise.resolve(observations),
  }
}

describe('presence during the very first poll', () => {
  it('never flags a teammate whose beacon is in the same listing as departed', async () => {
    const { session, ids } = await team(['Ana', 'Ben', 'Cat', 'Ghost'])
    const poller = new Poller(session, new EventStore(session))
    const live = ['Ana', 'Ben', 'Cat']
    stubListing(
      poller,
      live.map((n) => beaconOf(ids.get(n)!, n)),
    )

    // Exactly how chatService is wired: a new device means re-derive and push.
    const pushes: PresenceView[][] = []
    poller.listeners = {
      onNewDevice: () => pushes.push(poller.presenceViews()),
      onPresence: (views) => pushes.push(views),
    }
    await poller.tick()

    const liveIds = new Set(live.map((n) => ids.get(n)!.deviceId))
    expect(pushes.length).toBe(live.length + 1) // one per device, then the tick's own
    for (const views of pushes) {
      expect(views.filter((v) => v.departed && liveIds.has(v.deviceId))).toEqual([])
    }
  })

  it('still hides a registration with no beacon at all once the listing is in', async () => {
    const { session, ids } = await team(['Ana', 'Ghost'])
    const poller = new Poller(session, new EventStore(session))
    stubListing(poller, [beaconOf(ids.get('Ana')!, 'Ana')])

    const before = poller.presenceViews()
    expect(before.every((v) => !v.departed)).toBe(true) // no listing yet: absence means nothing

    await poller.tick()
    const after = new Map(poller.presenceViews().map((v) => [v.deviceId, v]))
    expect(after.get(ids.get('Ana')!.deviceId)?.departed).toBe(false)
    expect(after.get(ids.get('Ghost')!.deviceId)?.departed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The poll loop (1.2)
//
// Three things about the loop are easy to get wrong and invisible when they
// are: how many chains of setTimeout are alive at once, what period a client
// that never gets a tier change runs at, and whether the first tick does the
// blanket sweep that channel discovery lives inside. All three are measured
// here by counting reader.poll() calls on a fake clock.

interface PollRig {
  session: Session
  poller: Poller
  /** reader.poll() calls since the last reset(). */
  calls(): number
  reset(): void
  /** Leave every poll pending (a slow share) until release(). */
  stall(on: boolean): void
  release(): void
  /** Conversations the blanket sweep has caught up, in order. */
  sweeps: string[]
  /** Channel-discovery passes (loadChannels), which live inside the sweep. */
  discoveries(): number
}

/**
 * A poller whose share reads are instrumented and whose sweep does no I/O, so
 * a tick costs exactly one counted poll and the arithmetic is the test.
 */
async function pollRig(peers: string[] = []): Promise<PollRig> {
  const { session } = await team(peers)
  const events = new EventStore(session)
  const poller = new Poller(session, events)
  const sweeps: string[] = []
  let discoveries = 0
  vi.spyOn(events, 'catchUp').mockImplementation(async (conv) => {
    sweeps.push(conv)
    return 0
  })
  vi.spyOn(session, 'loadChannels').mockImplementation(async () => {
    discoveries++
  })

  let calls = 0
  let stalled = false
  let pending: (() => void)[] = []
  ;(poller as unknown as { reader: Pick<BeaconReader, 'poll'> }).reader = {
    poll: () => {
      calls++
      if (!stalled) return Promise.resolve([])
      return new Promise((resolve) => pending.push(() => resolve([])))
    },
  }
  return {
    session,
    poller,
    calls: () => calls,
    reset: () => {
      calls = 0
    },
    stall: (on) => {
      stalled = on
    },
    release: () => {
      const waiting = pending
      pending = []
      for (const r of waiting) r()
    },
    sweeps,
    discoveries: () => discoveries,
  }
}

/** Hand the event loop enough turns for a tick's awaits to finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
}

describe('poll loop', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not fork a second chain when the tier speeds up mid-tick', async () => {
    const rig = await pollRig()
    vi.useFakeTimers()
    try {
      // A tick is in flight (slow share) exactly when the window is brought to
      // the front. The kick has to take the chain over, not run beside it.
      rig.stall(true)
      rig.poller.start()
      await settle()
      expect(rig.calls()).toBe(1)
      rig.poller.setTier('focused')
      await settle()
      rig.stall(false)
      rig.release() // both the stale tick and the kicked one complete
      await settle()

      rig.reset()
      await vi.advanceTimersByTimeAsync(10_000)
      // One chain at POLL.focusedMs. Two chains (the bug) double it, and every
      // further speed-up used to add another one on top.
      const oneChain = 10_000 / POLL.focusedMs
      expect(rig.calls()).toBeGreaterThanOrEqual(oneChain - 1)
      expect(rig.calls()).toBeLessThanOrEqual(oneChain + 1)

      // …and it still holds after a slow-down and another speed-up mid-tick.
      rig.poller.setTier('idle')
      rig.stall(true)
      await vi.advanceTimersByTimeAsync(POLL.idleMs)
      rig.poller.setTier('focused')
      await settle()
      rig.stall(false)
      rig.release()
      await settle()
      rig.reset()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(rig.calls()).toBeLessThanOrEqual(oneChain + 1)
    } finally {
      rig.poller.stop()
    }
  }, 60_000)

  it('polls at the background cadence when nothing ever changes the tier', async () => {
    const rig = await pollRig()
    // A client that launches unfocused is already in its starting tier, so
    // setTier('blurred') early-returns and nothing else ever sets the period.
    expect(rig.poller.intervalMs).toBe(POLL.backgroundMs)
    vi.useFakeTimers()
    try {
      rig.poller.start()
      await settle()
      rig.reset()
      await vi.advanceTimersByTimeAsync(30_000)
      const expected = 30_000 / POLL.backgroundMs
      expect(rig.calls()).toBeGreaterThanOrEqual(expected - 1)
      expect(rig.calls()).toBeLessThanOrEqual(expected + 1) // 20 at POLL.defaultMs
    } finally {
      rig.poller.stop()
    }
  }, 60_000)

  it('sweeps on the very first tick, so channel discovery is not a period late', async () => {
    const rig = await pollRig()
    vi.useFakeTimers()
    try {
      rig.poller.start()
      await settle()
      expect(rig.discoveries()).toBe(1)
      // Every fixed team log is in the first sweep (channels and DMs too, when
      // a team has any), rather than arriving one sweep period after launch.
      expect(rig.sweeps).toEqual(expect.arrayContaining(Object.values(TEAM_CONV)))
      // And it is still a cadence, not every tick.
      const after = rig.sweeps.length
      await vi.advanceTimersByTimeAsync(POLL.sweepBlurredMs - POLL.backgroundMs)
      expect(rig.sweeps.length).toBe(after)
      await vi.advanceTimersByTimeAsync(POLL.backgroundMs * 2)
      expect(rig.sweeps.length).toBeGreaterThan(after)
    } finally {
      rig.poller.stop()
    }
  }, 60_000)

  it('is silent while paused and ticks the moment it is resumed', async () => {
    const rig = await pollRig()
    vi.useFakeTimers()
    try {
      rig.poller.start()
      await settle()
      rig.poller.setTier('paused')
      rig.reset()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(rig.calls()).toBe(0) // a locked screen reads nothing at all

      rig.poller.setTier('focused')
      // No timer has been advanced: coming back from paused ticks synchronously,
      // so the window never shows a stale room while the clock catches up.
      expect(rig.calls()).toBe(1)
      await settle()
      rig.reset()
      await vi.advanceTimersByTimeAsync(5 * POLL.focusedMs)
      expect(rig.calls()).toBe(5)
    } finally {
      rig.poller.stop()
    }
  }, 60_000)

  it('ticks immediately when the window comes back from idle', async () => {
    const rig = await pollRig()
    vi.useFakeTimers()
    try {
      rig.poller.start()
      await settle()
      rig.poller.setTier('idle')
      await vi.advanceTimersByTimeAsync(POLL.idleMs)
      await settle()
      rig.reset()
      rig.poller.setTier('focused') // faster: kick now rather than in 15 s
      expect(rig.calls()).toBe(1)
      await settle()
      rig.reset()
      await vi.advanceTimersByTimeAsync(3 * POLL.focusedMs)
      expect(rig.calls()).toBe(3)
    } finally {
      rig.poller.stop()
    }
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Presence freshness and what an unverified beacon may claim

describe('presence from a beacon', () => {
  const viewOf = (poller: Poller, deviceId: string): PresenceView | undefined =>
    poller.presenceViews().find((v) => v.deviceId === deviceId)

  it('judges freshness by the beacon stamp, not by when this reader noticed it', async () => {
    const { session, ids } = await team(['Ana'])
    const ana = ids.get('Ana')!
    const poller = new Poller(session, new EventStore(session))
    const shareNow = session.io.calibratedNow()
    // A cold start (or a resume from a locked screen): we have just read a file
    // a teammate wrote ten minutes ago before their laptop went home. Measured
    // from the read, this looked like a teammate who is online right now.
    stubListing(poller, [beaconOf(ana, 'Ana', { stampedAt: shareNow - 10 * 60_000, noticedAt: Date.now() })])
    await poller.tick()
    expect(viewOf(poller, ana.deviceId)?.state).toBe('offline')
  })

  it('keeps a 45–48 s idle heartbeat online at either reader tier', async () => {
    // The reader's own tick rate decides how late it notices a beacon: 1 s when
    // the window is in front, 15 s when the client is idle. Since the verdict
    // now comes from the stamp, that delay no longer eats into the 2 s of slack
    // between BEACON.idleHeartbeatMs + jitter and PRESENCE.onlineWithinMs.
    const stampAge = BEACON.idleHeartbeatMs + BEACON.heartbeatJitterMs
    expect(stampAge).toBeLessThan(PRESENCE.onlineWithinMs)
    for (const noticedAgo of [POLL.focusedMs, POLL.idleMs]) {
      const { session, ids } = await team(['Ana'])
      const ana = ids.get('Ana')!
      const poller = new Poller(session, new EventStore(session))
      stubListing(poller, [
        beaconOf(ana, 'Ana', {
          stampedAt: session.io.calibratedNow() - stampAge,
          noticedAt: Date.now() - noticedAgo,
        }),
      ])
      await poller.tick()
      expect(viewOf(poller, ana.deviceId)?.state).toBe('online')
    }
  })

  it('calls a device offline once its last beacon is older than the threshold, whatever our tier', async () => {
    // The other half of the same arithmetic: an idle reader notices a departing
    // device's final beacon up to POLL.idleMs after it was written, and that
    // delay used to postpone "offline" by exactly as much.
    for (const noticedAgo of [POLL.focusedMs, POLL.idleMs]) {
      const { session, ids } = await team(['Ana'])
      const ana = ids.get('Ana')!
      const poller = new Poller(session, new EventStore(session))
      const stampedAt = session.io.calibratedNow() - (PRESENCE.offlineAfterMs + 1000)
      stubListing(poller, [beaconOf(ana, 'Ana', { stampedAt, noticedAt: Date.now() - noticedAgo })])
      await poller.tick()
      expect(viewOf(poller, ana.deviceId)?.state).toBe('offline')
    }
  })

  it('derives away from the idleSec a peer advertises while its beacon is fresh', async () => {
    const { session, ids } = await team(['Ana'])
    const ana = ids.get('Ana')!
    const poller = new Poller(session, new EventStore(session))
    stubListing(poller, [beaconOf(ana, 'Ana', { idleSec: PRESENCE.awayIdleSec })])
    await poller.tick()
    expect(viewOf(poller, ana.deviceId)?.state).toBe('away')
  })

  it('never raises — or shows — a build number from an unverified beacon', async () => {
    const { session, ids } = await team(['Ana', 'Ben'])
    const ana = ids.get('Ana')!
    const ben = ids.get('Ben')!
    const poller = new Poller(session, new EventStore(session))
    // Anyone who can write to the share can write a beacon; only a signature
    // from a pinned roster key makes it evidence. An update banner must not be
    // raisable by the former.
    stubListing(poller, [
      beaconOf(ana, 'Ana', { app: '9.9.9', verified: false }),
      beaconOf(ben, 'Ben', { app: '1.2.0', verified: true }),
    ])
    const announced: { version: string; name: string }[] = []
    poller.listeners = { onPeerVersion: (version, name) => announced.push({ version, name }) }
    await poller.tick()

    expect(announced).toEqual([{ version: '1.2.0', name: 'Ben' }])
    expect(viewOf(poller, ana.deviceId)?.app).toBeUndefined()
    expect(viewOf(poller, ben.deviceId)?.app).toBe('1.2.0')
  })
})

// ---------------------------------------------------------------------------
// Share I/O budget (1.2)
//
// The question this answers is "how much traffic does one client make when the
// team is quiet", per tier, with a counting in-memory share so 25 simulated
// minutes cost no disk and no wall clock. Everything a resting client polls is
// here: the beacon loop (read side), the beacon writer (write side), the
// drops inbox, and the rtc signal listener. The numbers are printed so a
// reviewer can see what the budget is actually buying.

/** An in-memory share that counts logical operations. Same surface as ShareIo. */
class MemIo extends ShareIo {
  ops = 0
  counts: Record<string, number> = {}

  constructor(
    private mem: Map<string, Buffer>,
    private memDirs: Set<string>,
  ) {
    super('/mem')
  }

  private n(op: string): void {
    this.ops++
    this.counts[op] = (this.counts[op] ?? 0) + 1
  }

  reset(): void {
    this.ops = 0
    this.counts = {}
  }

  private entries(rel: string): { files: string[]; dirs: string[] } {
    const prefix = rel === '' ? '' : `${rel}/`
    const files = new Set<string>()
    const dirs = new Set<string>()
    for (const k of this.mem.keys()) {
      if (prefix && !k.startsWith(prefix)) continue
      const rest = k.slice(prefix.length)
      if (!rest) continue
      const i = rest.indexOf('/')
      if (i === -1) files.add(rest)
      else dirs.add(rest.slice(0, i))
    }
    for (const d of this.memDirs) {
      if (prefix && !d.startsWith(prefix)) continue
      const rest = d.slice(prefix.length)
      if (!rest) continue
      const i = rest.indexOf('/')
      dirs.add(i === -1 ? rest : rest.slice(0, i))
    }
    return { files: [...files, ...dirs], dirs: [...dirs] }
  }

  override async ensureDir(rel: string): Promise<void> {
    this.n('mkdir')
    this.memDirs.add(rel)
  }

  override async publish(rel: string, data: Buffer, opts?: { calibrate?: boolean }): Promise<void> {
    this.n('publish')
    this.mem.set(rel, Buffer.from(data))
    if (opts?.calibrate) this.n('stat')
  }

  override async createExclusive(rel: string, data: Buffer): Promise<boolean> {
    this.n('publish')
    if (this.mem.has(rel)) return false
    this.mem.set(rel, Buffer.from(data))
    return true
  }

  override async read(rel: string): Promise<Buffer> {
    this.n('read')
    const b = this.mem.get(rel)
    if (!b) {
      const err = new Error(`ENOENT ${rel}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return b
  }

  override async readMaybe(rel: string): Promise<Buffer | null> {
    try {
      return await this.read(rel)
    } catch {
      return null
    }
  }

  override async list(rel: string): Promise<string[]> {
    this.n('readdir')
    return this.entries(rel).files
  }

  override async listDirs(rel: string): Promise<string[]> {
    this.n('readdir')
    return this.entries(rel).dirs
  }

  override async statMaybe(rel: string): Promise<{ mtimeMs: number; size: number } | null> {
    this.n('stat')
    const b = this.mem.get(rel)
    return b ? { mtimeMs: Date.now(), size: b.length } : null
  }

  override async delete(rel: string): Promise<'deleted' | 'retry'> {
    this.n('delete')
    this.mem.delete(rel)
    for (const k of [...this.mem.keys()]) if (k.startsWith(`${rel}/`)) this.mem.delete(k)
    this.memDirs.delete(rel)
    return 'deleted'
  }

  override async probe(): Promise<boolean> {
    this.n('stat')
    return true
  }
}

const budgetSettings = (): SettingsView => ({
  theme: 'system',
  notifyChannels: 'none',
  notifyPreviews: false,
  autoplayGifs: 'never',
  autoAcceptBeams: false,
  quietHours: { enabled: false, from: '22:00', to: '07:00' },
  fontSize: 'M',
})

type Tier = 'focused' | 'blurred' | 'idle' | 'paused'

interface BudgetRig {
  io: MemIo
  session: Session
  poller: Poller
  beacon: BeaconWriter
  peers: { beacon: BeaconWriter }[]
  start(): void
  stop(): Promise<void>
  setTier(tier: Tier): void
  /** Advance `seconds` of simulated time with the peers heartbeating. */
  run(seconds: number): Promise<void>
}

/**
 * One client (us) plus `peerNames` teammates on the same in-memory share, wired
 * the way ChatService wires them. Also feature-detects the 1.2 tier API so the
 * exact same harness can be pointed at a pre-1.2 tree for a before/after
 * comparison.
 */
async function budgetRig(peerNames: string[]): Promise<BudgetRig> {
  const mem = new Map<string, Buffer>()
  const memDirs = new Set<string>()
  const io = new MemIo(mem, memDirs)
  const res = await createOrJoinTeam(io, 'correct horse battery staple', 'Budget Team')
  if ('error' in res) throw new Error(res.error)
  const { proto, teamSalt, tmk } = res.join

  const mine = generateIdentity().identity
  const seed = new Session(
    io,
    new FakeStore(),
    mine,
    proto,
    teamSalt,
    tmk,
    tmk,
    new Roster(io, new FakeStore(), tmk, proto.epoch),
    'Me',
  )
  const kMeta = seed.keys.kMeta

  const register = async (rIo: MemIo, identity: DeviceIdentity, name: string): Promise<void> => {
    const roster = new Roster(rIo, new FakeStore(), kMeta, proto.epoch)
    await roster.publishSelf(identity, {
      deviceId: identity.deviceId,
      edPub: identity.edPub,
      xPub: identity.xPub,
      displayName: name,
      hostname: `${name}-host`,
      osUser: name.toLowerCase(),
      platform: 'darwin',
      machineIdHash: null,
      firstSeen: Date.now(),
      recSeq: 1,
    })
  }
  await register(io, mine, 'Me')

  const peers: { beacon: BeaconWriter }[] = []
  for (const name of peerNames) {
    const pIo = new MemIo(mem, memDirs) // same folder, its own counter
    const identity = generateIdentity().identity
    await register(pIo, identity, name)
    const pRoster = new Roster(pIo, new FakeStore(), kMeta, proto.epoch)
    pRoster.loadPins()
    await pRoster.refresh()
    const pSession = new Session(pIo, new FakeStore(), identity, proto, teamSalt, tmk, tmk, pRoster, name)
    peers.push({ beacon: new BeaconWriter(pSession, () => '1.2.0') })
  }

  const roster = new Roster(io, new FakeStore(), kMeta, proto.epoch)
  roster.loadPins()
  await roster.refresh()
  const session = new Session(io, new FakeStore(), mine, proto, teamSalt, tmk, tmk, roster, 'Me')
  session.refreshDms()
  await session.createChannel('general', 'Team-wide chat')
  await session.loadChannels()

  const events = new EventStore(session)
  const poller = new Poller(session, events)
  const beacon = new BeaconWriter(session, () => '1.2.0')

  // The two share pollers that live outside the beacon loop.
  const { DropService } = await import('../services/drops')
  const { SignalService } = await import('../services/signal')
  const drops = new DropService(
    { session, beacon } as never,
    () => null,
    () => {},
    () => budgetSettings(),
  ) as unknown as { start(): void; stop(): void; setTier?(t: Tier): void }
  const signal = new SignalService(session, () => {}) as unknown as { start(): void; stop(): void }

  // Every conversation gets one message, so each has a day directory the sweep
  // has to open — an empty log would flatter the numbers.
  const convs = [
    ...[...session.channels.values()].map((c) => `chan:${c.channelId}` as const),
    ...[...session.dms.values()].map((d) => `dm:${d.pairToken}` as const),
    ...Object.values(TEAM_CONV),
  ]
  for (const c of convs) {
    await events.publish(c, 'msg', {
      t: 'msg',
      conv: c,
      author: { device: session.deviceId, name: 'Me' },
      senderSeq: 1,
      sentWall: Date.now(),
      body: { kind: 'text', text: 'hello' },
    } as never)
  }
  // What ChatService.start() does before the loops begin: every conversation
  // caught up once, so the measurement sees a steady state, not a cold start.
  for (const c of convs) await events.catchUp(c)

  let tierNow: Tier = 'blurred'
  const setTier = (tier: Tier): void => {
    tierNow = tier
    const p = poller as unknown as { setTier?(t: Tier): void; intervalMs: number }
    const b = beacon as unknown as { setTier?(t: Tier, idle?: number): void }
    if (p.setTier) p.setTier(tier)
    else p.intervalMs = tier === 'focused' ? POLL.focusedMs : POLL.backgroundMs // pre-1.2
    b.setTier?.(tier, tier === 'idle' ? 300 : tier === 'paused' ? 900 : 0)
    drops.setTier?.(tier)
  }

  let clock = 0
  const run = async (seconds: number): Promise<void> => {
    for (let i = 0; i < seconds; i++) {
      await vi.advanceTimersByTimeAsync(1000)
      clock++
      // Teammates are in the same state we are — an idle team is idle all
      // round — so their heartbeats follow the same tier, staggered the way
      // four real clients would land.
      const every = tierNow === 'idle' ? 45 : 20
      for (let p = 0; p < peers.length; p++) {
        if ((clock + p * 5) % every === 0) await peers[p].beacon.bump('heartbeat')
      }
    }
  }

  return {
    io,
    session,
    poller,
    beacon,
    peers,
    start(): void {
      beacon.start()
      poller.start()
      drops.start()
      signal.start()
    },
    async stop(): Promise<void> {
      poller.stop()
      drops.stop()
      signal.stop()
      await beacon.stop(false)
    },
    setTier,
    run,
  }
}

const BUDGET_TIERS = ['focused', 'blurred', 'idle', 'paused'] as const

describe('share I/O budget', () => {
  const measured: Record<string, number> = {}
  const breakdown: Record<string, Record<string, number>> = {}
  let report = ''

  // One run of the harness for all four tiers; each tier then gets its own
  // assertion below. Vitest's reporter prints neither console.log nor the names
  // of *passing* tests, so the measurement is written straight to stdout —
  // otherwise the one number this whole stream is about is only ever visible
  // when the budget has already been blown.
  beforeAll(async () => {
    const rig = await budgetRig(['Ana', 'Ben', 'Cat', 'Dee'])
    vi.useFakeTimers()
    try {
      rig.start()
      // Settle: the rtc listener idles out, the first blanket sweep lands, and
      // every peer has beaconed at least once.
      await rig.run(150)

      for (const tier of BUDGET_TIERS) {
        rig.setTier(tier)
        await rig.run(10) // transition costs belong to neither window
        rig.io.reset()
        // Ten minutes: long enough that even the idle tier's ten-minute
        // blanket sweep lands inside the window, so no tier is flattered by
        // a cost that merely fell outside it.
        await rig.run(600)
        measured[tier] = rig.io.ops / 10
        breakdown[tier] = { ...rig.io.counts }
      }
    } finally {
      await rig.stop()
      vi.useRealTimers()
    }
    report = BUDGET_TIERS.map((t) => `${t} ${measured[t].toFixed(1)}/min`).join(' · ')
    const detail = BUDGET_TIERS.map((t) => `${t} ${JSON.stringify(breakdown[t])}`).join(' · ')
    process.stdout.write(
      `\n  share I/O per client, team of 5, nobody chatting, file transfers excluded\n` +
        `    ${report}   (budget: focused ${IO_BUDGET.focusedOpsPerMin} · blurred ${IO_BUDGET.blurredOpsPerMin} · idle ${IO_BUDGET.idleOpsPerMin})\n` +
        `    ${detail}\n`,
    )
  }, 120_000)

  it('holds the focused tier inside IO_BUDGET.focusedOpsPerMin', () => {
    expect(
      measured.focused,
      `focused: ${measured.focused?.toFixed(1)} ops/min vs budget ${IO_BUDGET.focusedOpsPerMin} — ${report}`,
    ).toBeLessThanOrEqual(IO_BUDGET.focusedOpsPerMin)
  })

  it('holds the blurred tier inside IO_BUDGET.blurredOpsPerMin', () => {
    expect(
      measured.blurred,
      `blurred: ${measured.blurred?.toFixed(1)} ops/min vs budget ${IO_BUDGET.blurredOpsPerMin} — ${report}`,
    ).toBeLessThanOrEqual(IO_BUDGET.blurredOpsPerMin)
  })

  it('holds the idle tier inside IO_BUDGET.idleOpsPerMin', () => {
    expect(
      measured.idle,
      `idle: ${measured.idle?.toFixed(1)} ops/min vs budget ${IO_BUDGET.idleOpsPerMin} — ${report}`,
    ).toBeLessThanOrEqual(IO_BUDGET.idleOpsPerMin)
  })

  it('is completely silent while paused', () => {
    expect(measured.paused, `paused must be silent, measured ${measured.paused?.toFixed(1)} ops/min — ${report}`).toBe(0)
  })

  it('gets cheaper at every step down — a tier that does not is not a tier', () => {
    expect(measured.idle, report).toBeLessThan(measured.blurred)
    expect(measured.blurred, report).toBeLessThan(measured.focused)
  })

  it('keeps headroom, so a team that grows a person does not break the assertion', () => {
    // The budgets are assertion targets, not behaviour; they are useful only
    // while there is slack between the measurement and the number. Documented
    // in docs/contract-changes-1.2.md.
    const headroom = (m: number, budget: number): number => (budget - m) / budget
    expect(headroom(measured.focused, IO_BUDGET.focusedOpsPerMin), report).toBeGreaterThan(0.05)
    expect(headroom(measured.blurred, IO_BUDGET.blurredOpsPerMin), report).toBeGreaterThan(0.05)
    expect(headroom(measured.idle, IO_BUDGET.idleOpsPerMin), report).toBeGreaterThan(0.05)
  })
})
