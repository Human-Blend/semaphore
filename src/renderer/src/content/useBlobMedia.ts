import { useCallback, useEffect, useRef, useState } from 'react'
import type { Attachment } from '@shared/types'
import { useStore } from '@/store'
import { blobUrl } from './parse'
import {
  blobRetryUrl,
  decideBlobRetry,
  shouldRetryOnBlobState,
  shouldRetryOnReachable,
} from './blobRetry'

// One <img>/<video> src for a shared blob, with the retry that keeps it honest.
// The policy is in blobRetry.ts; this is the wiring: a monotonic sequence for
// cache-busting, a backoff timer, and the two store signals that mean "try
// again now" (the share is reachable again, the blob finished downloading).

export type BlobPhase = 'loading' | 'ok' | 'retrying' | 'expired'

export interface BlobMedia {
  /** Put this in `src` — it changes on every retry, which is what re-requests. */
  src: string
  phase: BlobPhase
  onError: () => void
  onLoad: () => void
}

type BlobAtt = Pick<Attachment, 'blobId' | 'key' | 'name' | 'size'>

/**
 * Why the last load failed, asked of the one thing that knows.
 *
 * An `error` event carries no status, and the page cannot read an `sfblob://`
 * URL with `fetch` to find out — a custom scheme is cross-origin to the
 * document, so the request is CORS-blocked before it ever reaches the handler
 * (images are exempt; that is why they work at all). `files.fetchBlob` answers
 * the same question over the typed bridge, by the same rule the protocol
 * handler picks 404 over 503 with: `expired` only for a file that is really
 * gone from a share we can still see. It also pulls the blob into the local
 * cache, which is what makes the *next* outage a non-event for this tile.
 *
 * Returned as an HTTP status so the policy module stays in one vocabulary.
 */
async function probeBlobStatus(att: BlobAtt): Promise<number | null> {
  try {
    const state = await window.bridge.files.fetchBlob(att.blobId, att.key, att.name, att.size)
    return state.state === 'expired' ? 404 : null
  } catch {
    // 'not-ready' — the file services are still wiring. Nothing is known yet.
    return null
  }
}

export function useBlobMedia(att: BlobAtt): BlobMedia {
  const base = blobUrl(att)
  const [seq, setSeq] = useState(0)
  const [phase, setPhase] = useState<BlobPhase>('loading')
  const failures = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Read through refs inside the effects below so they depend on the *signal*,
  // never on the phase — an effect that re-ran on its own outcome would spin.
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const attRef = useRef(att)
  attRef.current = att

  const reachable = useStore((s) => s.health.reachable)
  const blobState = useStore((s) => s.blobs[att.blobId]?.state)

  const clear = (): void => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  const retryNow = useCallback(() => {
    clear()
    failures.current = 0
    // Keep the overlay: this is a retry, not a fresh tile.
    setPhase((p) => (p === 'ok' ? p : 'retrying'))
    setSeq((n) => n + 1)
  }, [])

  // A different blob in the same element (the lightbox moving on, a recycled
  // row) starts over from a clean slate.
  useEffect(() => {
    clear()
    failures.current = 0
    setSeq(0)
    setPhase('loading')
  }, [base])

  useEffect(() => clear, [])

  // The share came back — try at once, whatever the backoff had planned.
  const prevReachable = useRef(reachable)
  useEffect(() => {
    const was = prevReachable.current
    prevReachable.current = reachable
    if (shouldRetryOnReachable(was, reachable) && phaseRef.current !== 'ok') retryNow()
  }, [reachable, retryNow])

  // The blob finished downloading into the local cache (a `blob` push).
  const prevBlobState = useRef(blobState)
  useEffect(() => {
    const was = prevBlobState.current
    prevBlobState.current = blobState
    if (shouldRetryOnBlobState(was, blobState) && phaseRef.current !== 'ok') retryNow()
  }, [blobState, retryNow])

  const onError = useCallback(() => {
    clear()
    const failed = failures.current + 1
    failures.current = failed
    setPhase('retrying')
    void (async () => {
      const status = await probeBlobStatus(attRef.current)
      // A load that succeeded (or a retry that moved on) while we were asking
      // must not be undone by this answer.
      if (phaseRef.current === 'ok' || failures.current !== failed) return
      const decision = decideBlobRetry({ failures: failed, status })
      if (decision.action === 'expired') {
        setPhase('expired')
        return
      }
      // 'wait' keeps the overlay up and the timer off: reachability (or a blob
      // push) is what restarts us from here.
      if (decision.action === 'retry') {
        timer.current = setTimeout(() => setSeq((n) => n + 1), decision.delayMs)
      }
    })()
  }, [base])

  const onLoad = useCallback(() => {
    clear()
    failures.current = 0
    setPhase('ok')
  }, [])

  return { src: blobRetryUrl(base, seq), phase, onError, onLoad }
}
