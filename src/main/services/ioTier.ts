import { POLL } from '@shared/constants'

// Share I/O tiers (1.2). Everything that polls the share reads its cadence from
// one place, so "how much traffic does an idle client make" has a single answer.
//
// The tier is derived, never set: window focus, OS input idleness
// (powerMonitor.getSystemIdleTime), and the lock/suspend signals decide it. The
// electron wiring lives in src/main/index.ts; this class is pure so the budget
// test can drive it with fake timers and no app.

export type IoTier = 'focused' | 'blurred' | 'idle' | 'paused'

/** How often the OS idle counter is sampled. Cheap (no share I/O) but not free. */
export const IDLE_SAMPLE_MS = 30_000

export interface IoTierDeps {
  /** Seconds since the last OS-wide keyboard/mouse input. */
  getSystemIdleSec: () => number
  /** False while the window is hidden or minimized (no window at all counts as hidden). */
  isWindowVisible: () => boolean
  now?: () => number
}

export type IoTierListener = (tier: IoTier, idleSec: number) => void

/** Poll cadence for a tier — `null` means "do not poll at all". */
export function tickMsFor(tier: IoTier): number | null {
  switch (tier) {
    case 'focused':
      return POLL.focusedMs
    case 'blurred':
      return POLL.backgroundMs
    case 'idle':
      return POLL.idleMs
    case 'paused':
      return null
  }
}

/** Blanket catch-up sweep cadence for a tier — `null` means "never sweep". */
export function sweepMsFor(tier: IoTier): number | null {
  switch (tier) {
    case 'focused':
      return POLL.sweepFocusedMs
    case 'blurred':
      return POLL.sweepBlurredMs
    case 'idle':
      return POLL.sweepIdleMs
    case 'paused':
      return null
  }
}

/** drops/<self> inbox scan cadence for a tier. A beacon hint always scans now. */
export function dropsInboxMsFor(tier: IoTier): number | null {
  switch (tier) {
    case 'focused':
    case 'blurred':
      return POLL.dropsInboxMs
    case 'idle':
      return POLL.dropsInboxIdleMs
    case 'paused':
      return null
  }
}

export class IoTierManager {
  private deps: IoTierDeps
  private listeners: IoTierListener[] = []
  private sampler: NodeJS.Timeout | null = null
  private focused = false
  private visible = true
  private locked = false
  private suspended = false
  /** When the window last went out of sight while unfocused; 0 = it is in sight. */
  private hiddenSince = 0
  private systemIdleSec = 0
  private current: IoTier = 'blurred'

  constructor(deps: IoTierDeps) {
    this.deps = deps
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  get tier(): IoTier {
    return this.current
  }

  /** Seconds of OS input idleness last sampled — what the beacon advertises. */
  get idleSec(): number {
    return this.systemIdleSec
  }

  start(): void {
    if (this.sampler) return
    this.sample()
    this.sampler = setInterval(() => this.sample(), IDLE_SAMPLE_MS)
    // A sampler is not a reason to keep the process alive.
    this.sampler.unref?.()
  }

  stop(): void {
    if (this.sampler) clearInterval(this.sampler)
    this.sampler = null
  }

  onChange(cb: IoTierListener): () => void {
    this.listeners.push(cb)
    // New subscribers get the current tier straight away: a service created
    // after the manager started would otherwise sit on its constructor default.
    cb(this.current, this.systemIdleSec)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb)
    }
  }

  // ---------------------------------------------------------------------------
  // Inputs

  setFocused(focused: boolean): void {
    this.focused = focused
    if (focused) {
      this.visible = true
      this.hiddenSince = 0
      this.systemIdleSec = 0 // focus IS input; don't wait for the next sample
    } else if (!this.visible && !this.hiddenSince) {
      this.hiddenSince = this.now()
    }
    this.evaluate()
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.hiddenSince = visible ? 0 : this.hiddenSince || this.now()
    this.evaluate()
  }

  setLocked(locked: boolean): void {
    this.locked = locked
    if (!locked) this.systemIdleSec = 0 // unlocking is input
    this.evaluate()
  }

  setSuspended(suspended: boolean): void {
    this.suspended = suspended
    if (!suspended) this.systemIdleSec = 0
    this.evaluate()
  }

  /**
   * Re-read the OS idle counter now (also called on the sampler's cadence), and
   * reconcile what we believe about the window against what it actually is.
   * The show/hide/minimize/restore events are the fast path, but they are not
   * exhaustive — a window created after this manager, a Space switch, or an
   * event that arrived before `mainWindow` existed all leave `visible` stale,
   * and a stale `true` is what keeps a hidden client on the awake cadence.
   */
  sample(): void {
    if (this.locked || this.suspended) return // the OS counter is meaningless here
    this.reconcileVisibility()
    try {
      this.systemIdleSec = Math.max(0, Math.floor(this.deps.getSystemIdleSec()))
    } catch {
      this.systemIdleSec = 0 // no powerMonitor (or it threw): never fake idleness
    }
    this.evaluate()
  }

  /** Believe the window over our own bookkeeping; a throwing dep changes nothing. */
  private reconcileVisibility(): void {
    let visible: boolean
    try {
      visible = this.deps.isWindowVisible()
    } catch {
      return
    }
    if (visible === this.visible) return
    this.visible = visible
    // Only the transition is new information, so the hidden-since stopwatch
    // starts now rather than pretending we knew earlier.
    this.hiddenSince = visible ? 0 : this.now()
  }

  // ---------------------------------------------------------------------------

  private derive(): IoTier {
    if (this.locked || this.suspended) return 'paused'
    const inputIdle = this.systemIdleSec * 1000 >= POLL.idleAfterMs
    // Someone else's app has the keyboard and ours is not even on screen: no
    // one is going to look at this window until they bring it back.
    const outOfSight = !this.visible && !!this.hiddenSince && this.now() - this.hiddenSince >= POLL.idleAfterMs
    // The idle tier is for a window nobody is looking at. A *focused* window is
    // being watched whatever the keyboard says — reading a long thread,
    // following a screen share, waiting for a reply — and 15 s ticks there mean
    // typing indicators that never render and messages that land in batches. So
    // focus floors the tier at `blurred`: three quiet minutes still buy the
    // cheaper cadence, they just never buy the invisible one.
    // `idleSec` keeps travelling truthfully in the beacon either way, so peers
    // still show this person as "away" after PRESENCE.awayIdleSec.
    if (this.focused) return inputIdle ? 'blurred' : 'focused'
    return inputIdle || outOfSight ? 'idle' : 'blurred'
  }

  private lastNotifiedIdleSec = -1

  private evaluate(): void {
    const next = this.derive()
    // idleSec matters even when the tier doesn't move: the beacon carries it,
    // and peers derive "away" from it. Listeners record it silently — nothing
    // here provokes a share write on its own.
    if (next === this.current && this.systemIdleSec === this.lastNotifiedIdleSec) return
    this.current = next
    this.lastNotifiedIdleSec = this.systemIdleSec
    for (const cb of this.listeners) cb(next, this.systemIdleSec)
  }
}
