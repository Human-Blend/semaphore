// Retry policy for sfblob:// media.
//
// An <img src="sfblob://…"> can fail for reasons that have nothing to do with
// the file: the blob service is wired from the session, so a request made in
// the first moments of a relaunch can arrive before the protocol handler does
// (503), and a share that is unreachable for a minute answers 503 for every
// blob on it. Both used to latch — the tile fell back to the blurred inline
// thumb with "file service warming up" over it and stayed there until the
// component happened to remount.
//
// So: retry on a doubling backoff, and let the caller retry immediately on the
// two signals that mean "now it would work" (the share came back; a `blob`
// push says ready). Only a 404 — which main now reserves for a blob that is
// genuinely gone, never for an unreachable share — ends in "cleaned up".
//
// Pure and DOM-free so it can be tested without a renderer.

/** Consecutive failures after which a tile stops asking on its own. */
export const BLOB_RETRY_MAX_ATTEMPTS = 10

/**
 * The budget for a *foreground* read — fetching a diagram scene somebody is
 * waiting to look at.
 *
 * Shorter than a tile's on purpose: an image retries behind its blurred thumb
 * and a "warming up" pill for as long as it takes, but a scene fetch is
 * awaited by a tile that shows nothing new meanwhile (and by Export, behind a
 * spinner), so it gives up in seconds and leaves the next mount to try again.
 * Same rule, smaller budget: 1 + 2 + 4 s.
 */
export const BLOB_SCENE_RETRY_ATTEMPTS = 4

const BASE_MS = 1000
const CAP_MS = 30_000

/** 1 s, 2 s, 4 s … capped at 30 s. `failures` is 1-based (the first failure). */
export function blobRetryDelayMs(failures: number): number {
  if (failures <= 1) return BASE_MS
  // 2^30 ms already dwarfs the cap; clamping the exponent keeps Infinity out.
  const step = BASE_MS * 2 ** Math.min(failures - 1, 30)
  return Math.min(step, CAP_MS)
}

export interface BlobRetryInput {
  /** Consecutive failed loads, including the one being decided (1-based). */
  failures: number
  /** Failures to spend before giving up. Defaults to a background tile's budget. */
  maxAttempts?: number
  /**
   * What main says about the blob, as a status: 404 for a blob it knows is
   * gone, null when nothing is known (the file services are still wiring, the
   * share is unreachable, the answer never came).
   */
  status: number | null
}

export interface BlobRetryDecision {
  /**
   * `retry` — load again in `delayMs`.
   * `wait`  — stop asking, keep the "warming up" overlay: the share is down or
   *           the service never came up, and a reachability flip (or a `blob`
   *           push) is what should restart us.
   * `expired` — main says this blob is gone; say so.
   */
  action: 'retry' | 'wait' | 'expired'
  delayMs: number
}

export function decideBlobRetry({
  failures,
  status,
  maxAttempts = BLOB_RETRY_MAX_ATTEMPTS,
}: BlobRetryInput): BlobRetryDecision {
  // A 404 is authoritative and ends it: main says "expired" only for a file
  // that is really gone from a share it can still see — an unreachable share
  // answers 503 — and the load failing is the second opinion. Retrying it for
  // two more minutes would only spell "warming up" over a file nobody has.
  if (status === 404) return { action: 'expired', delayMs: 0 }
  if (failures < maxAttempts) {
    return { action: 'retry', delayMs: blobRetryDelayMs(failures) }
  }
  // Out of attempts with nothing conclusive: stop the timer, keep the "warming
  // up" overlay, and let the share coming back be what restarts us.
  return { action: 'wait', delayMs: 0 }
}

/**
 * The same blob URL, distinct per attempt.
 *
 * Without this the browser answers a retry out of its own memory cache — the
 * failed response included — and the element never touches the handler again.
 * `sfblob://` ignores unknown query parameters (it reads only key/name/size),
 * so this is invisible to main.
 */
export function blobRetryUrl(url: string, token: string | number): string {
  if (token === 0 || token === '') return url
  return `${url}${url.includes('?') ? '&' : '?'}retry=${encodeURIComponent(String(token))}`
}

/** A share that has just come back is worth one immediate attempt. */
export function shouldRetryOnReachable(was: boolean, now: boolean): boolean {
  return !was && now
}

/**
 * A `blob` push worth retrying on: the file has just landed in the local cache,
 * so a tile that gave up while it was downloading can paint now.
 */
export function shouldRetryOnBlobState(was: string | undefined, now: string | undefined): boolean {
  return now === 'ready' && was !== 'ready'
}
