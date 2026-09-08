import { HLC } from './constants'

// Hybrid logical clock. Total event order = (hlcMs, ctr, deviceId) which equals
// plain byte-wise filename sort of "<hlcMs 13>-<ctr 4>-<deviceId 8>".
//
// A reply always sorts after the message it replies to even when the replier's
// wall clock is behind: observing an event ratchets our clock forward. The
// ratchet is capped at maxSkewAheadMs past the calibrated share clock so one
// wildly-fast device cannot drag the whole team into the future.

export interface HlcState {
  lastMs: number
  ctr: number
}

export function newHlcState(): HlcState {
  return { lastMs: 0, ctr: 0 }
}

/** Stamp a new local event. calibratedNow = local wall clock + share offset. */
export function hlcTick(state: HlcState, calibratedNowMs: number): { ms: number; ctr: number } {
  const now = Math.max(0, Math.floor(calibratedNowMs))
  if (now > state.lastMs) {
    state.lastMs = now
    state.ctr = 0
  } else {
    state.ctr += 1
    if (state.ctr > 9999) {
      // 10k events in one ms from one device is unreachable in practice; if it
      // ever happens, spill into the next millisecond rather than overflow.
      state.lastMs += 1
      state.ctr = 0
    }
  }
  return { ms: state.lastMs, ctr: state.ctr }
}

/**
 * Fold an observed remote event timestamp into our clock (capped ratchet).
 * Returns true when the remote stamp exceeded the skew cap (caller may flag
 * the sender in the UI).
 */
export function hlcObserve(state: HlcState, observedMs: number, calibratedNowMs: number): boolean {
  const cap = calibratedNowMs + HLC.maxSkewAheadMs
  const capped = Math.min(observedMs, cap)
  if (capped > state.lastMs) {
    state.lastMs = capped
    state.ctr = 0
  } else if (capped === state.lastMs) {
    // keep ctr — next tick increments past any same-ms event we produced
  }
  return observedMs > cap
}
