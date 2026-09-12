import { describe, expect, it } from 'vitest'
import {
  BLOB_RETRY_MAX_ATTEMPTS,
  BLOB_SCENE_RETRY_ATTEMPTS,
  blobRetryDelayMs,
  blobRetryUrl,
  decideBlobRetry,
  shouldRetryOnBlobState,
  shouldRetryOnReachable,
} from './blobRetry'

// The policy behind "the images I was sent are blurred and say the file
// service is warming up, forever". Everything here is the decision half; the
// element wiring is in useBlobMedia.ts.

describe('blobRetryDelayMs', () => {
  it('doubles from 1 s and stops at 30 s', () => {
    expect([1, 2, 3, 4, 5, 6].map(blobRetryDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000])
  })

  it('never runs away, however many failures pile up', () => {
    expect(blobRetryDelayMs(9)).toBe(30000)
    expect(blobRetryDelayMs(400)).toBe(30000)
    expect(Number.isFinite(blobRetryDelayMs(5000))).toBe(true)
  })

  it('treats a first (or nonsensical) failure count as the base delay', () => {
    expect(blobRetryDelayMs(1)).toBe(1000)
    expect(blobRetryDelayMs(0)).toBe(1000)
  })
})

describe('decideBlobRetry', () => {
  it('keeps retrying while attempts remain and nothing conclusive came back', () => {
    for (const status of [503, 500, null]) {
      expect(decideBlobRetry({ failures: 1, status })).toEqual({ action: 'retry', delayMs: 1000 })
      expect(decideBlobRetry({ failures: 3, status })).toEqual({ action: 'retry', delayMs: 4000 })
    }
  })

  it('calls it expired the moment main says 404 — that answer is authoritative', () => {
    // Main reserves 404 for a blob that is gone from a share it can still
    // reach; an unreachable one answers 503. Ten more attempts would only
    // spell "warming up" over a file nobody has.
    expect(decideBlobRetry({ failures: 1, status: 404 })).toEqual({ action: 'expired', delayMs: 0 })
    expect(decideBlobRetry({ failures: BLOB_RETRY_MAX_ATTEMPTS, status: 404 })).toEqual({
      action: 'expired',
      delayMs: 0,
    })
  })

  it('waits (overlay up, timer off) when the share is simply not answering', () => {
    for (const status of [503, 500, null]) {
      expect(decideBlobRetry({ failures: BLOB_RETRY_MAX_ATTEMPTS, status })).toEqual({
        action: 'wait',
        delayMs: 0,
      })
      expect(decideBlobRetry({ failures: BLOB_RETRY_MAX_ATTEMPTS + 40, status })).toEqual({
        action: 'wait',
        delayMs: 0,
      })
    }
  })

  it('takes a smaller budget for a foreground read, on the same schedule', () => {
    // A diagram scene: somebody is waiting for it, so it gives up in seconds
    // and leaves the next mount to try again — but 404 still means 404 and a
    // 503 is still retried, which is the part that matters.
    const scene = (failures: number) => decideBlobRetry({ failures, status: 503, maxAttempts: BLOB_SCENE_RETRY_ATTEMPTS })
    expect(scene(1)).toEqual({ action: 'retry', delayMs: 1000 })
    expect(scene(BLOB_SCENE_RETRY_ATTEMPTS - 1)).toEqual({ action: 'retry', delayMs: 4000 })
    expect(scene(BLOB_SCENE_RETRY_ATTEMPTS)).toEqual({ action: 'wait', delayMs: 0 })
    expect(decideBlobRetry({ failures: 1, status: 404, maxAttempts: BLOB_SCENE_RETRY_ATTEMPTS }).action).toBe('expired')
    // A tile with the same failure count is still going.
    expect(decideBlobRetry({ failures: BLOB_SCENE_RETRY_ATTEMPTS, status: 503 }).action).toBe('retry')
  })

  it('never gives up on an unexplained failure before the cap', () => {
    const attempts = Array.from({ length: BLOB_RETRY_MAX_ATTEMPTS - 1 }, (_, i) => i + 1)
    expect(attempts.every((n) => decideBlobRetry({ failures: n, status: null }).action === 'retry')).toBe(true)
  })
})

describe('blobRetryUrl', () => {
  const base = 'sfblob://blob/abc?key=k&name=n&size=9'

  it('leaves the first attempt alone', () => {
    expect(blobRetryUrl(base, 0)).toBe(base)
  })

  it('makes every later attempt a distinct URL the cache cannot answer', () => {
    expect(blobRetryUrl(base, 1)).toBe(`${base}&retry=1`)
    expect(blobRetryUrl(base, 2)).not.toBe(blobRetryUrl(base, 1))
  })

  it('starts the query string when there is none', () => {
    expect(blobRetryUrl('sfblob://blob/abc', 3)).toBe('sfblob://blob/abc?retry=3')
  })

  it('escapes the token, so a probe marker cannot forge another parameter', () => {
    expect(blobRetryUrl(base, 'probe&key=evil')).toBe(`${base}&retry=probe%26key%3Devil`)
  })
})

describe('retry triggers', () => {
  it('fires exactly on the share coming back', () => {
    expect(shouldRetryOnReachable(false, true)).toBe(true)
    expect(shouldRetryOnReachable(true, true)).toBe(false)
    expect(shouldRetryOnReachable(true, false)).toBe(false)
    expect(shouldRetryOnReachable(false, false)).toBe(false)
  })

  it('fires on a blob push that has just turned ready', () => {
    expect(shouldRetryOnBlobState('downloading', 'ready')).toBe(true)
    expect(shouldRetryOnBlobState(undefined, 'ready')).toBe(true)
    expect(shouldRetryOnBlobState('ready', 'ready')).toBe(false)
    expect(shouldRetryOnBlobState('ready', 'failed')).toBe(false)
  })
})
