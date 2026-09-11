import { create } from 'zustand'
import type { ConvId, RtcSignal, ScreenshareAnnounce, SysPayload, VerifiedEvent } from '@shared/types'
import type { ScreenSourceView } from '@shared/bridge'
import { FRAME, RTC } from '@shared/constants'

// Screen-share runtime: presenter capture + mesh answering + frame pipeline;
// viewer P2P attempt with automatic relay fallback. Imperative WebRTC state
// lives in this module; React reads the small zustand store below.
//
// v1 simplification vs the spec: the presenter's 1fps encrypted frame ring is
// ALWAYS on while sharing (not started on first relay viewer) — it costs one
// ~100-300KB write/s and makes fallback instant and multi-viewer trivial.

export interface ViewingState {
  sessionId: string
  conv: ConvId
  presenterDevice: string
  mode: 'connecting' | 'p2p' | 'relay'
  frameUrl: string | null
  streamId: string | null
}

export interface SharingState {
  sessionId: string
  conv: ConvId
  viewers: number
  liveViewers: number
  /** Name of the chosen source, for the presenter banner (1.2). */
  sourceName: string
  /** Cross-checked against the actual capture (`getSettings().displaySurface`),
   *  not just the picked source's kind — see `resolveSourceKind`. */
  sourceKind: 'screen' | 'window'
}

interface ScreenState {
  sharing: SharingState | null
  viewing: ViewingState | null
  pickerOpen: ConvId | null
  permissionPanel: boolean
}

export const useScreenStore = create<ScreenState>(() => ({
  sharing: null,
  viewing: null,
  pickerOpen: null,
  permissionPanel: false,
}))

// The viewer's live MediaStream can't live in zustand (not serializable-safe);
// components read it from here when streamId changes.
export let viewerStream: MediaStream | null = null

// ---------------------------------------------------------------------------

let inited = false
let frameCryptoKey: CryptoKey | null = null
let nonceBase: Uint8Array | null = null
let captureStream: MediaStream | null = null
let frameTimer: ReturnType<typeof setInterval> | null = null
let frameSeq = 0
let frameBusy = false
let frameQuality: number = FRAME.quality
const presenterPcs = new Map<string, RTCPeerConnection>() // viewerDeviceId -> pc

let viewerPc: RTCPeerConnection | null = null
let viewerTimers: ReturnType<typeof setTimeout>[] = []
let viewerFrameKey: CryptoKey | null = null
let viewerNonceBase: Uint8Array | null = null
let lastFrameUrl: string | null = null

export function initScreenShare(): void {
  if (inited) return
  inited = true
  window.bridge.onPush((msg) => {
    if (msg.kind === 'rtc-signal') void handleSignal(msg.signal)
    else if (msg.kind === 'frame') void handleFrame(msg.sessionId, msg.seq, msg.bytes)
    else if (msg.kind === 'frame-viewers') {
      const s = useScreenStore.getState().sharing
      if (s && s.sessionId === msg.sessionId) {
        useScreenStore.setState({ sharing: { ...s, viewers: msg.count + s.liveViewers } })
      }
    }
  })
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function importFrameKey(b64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(b64)
  return crypto.subtle.importKey('raw', raw.buffer as ArrayBuffer, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

function frameIv(base: Uint8Array, seq: number): Uint8Array {
  const iv = new Uint8Array(12)
  iv.set(base.subarray(0, 4), 0)
  new DataView(iv.buffer).setBigUint64(4, BigInt(seq))
  return iv
}

async function waitGathering(pc: RTCPeerConnection, timeoutMs = 1000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer)
        resolve()
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Presenter

/**
 * A uniform-color capture PNG-compresses to a fraction of the size a real
 * desktop or window snapshot does (menu bars, docks, wallpaper detail, text —
 * all of that costs bytes; flat color doesn't). There's no cheap way to
 * decode actual pixels here without a native image dependency (forbidden —
 * see CLAUDE.md's zero-native-modules rule), so compressed size is the
 * signal: below the ceiling, treat the thumbnail as blank.
 */
const BLANK_THUMBNAIL_BYTE_CEILING = 1200

export function looksBlankThumbnail(dataUrl: string): boolean {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  const bytes = Math.floor((b64.length * 3) / 4) - padding
  return bytes > 0 && bytes < BLANK_THUMBNAIL_BYTE_CEILING
}

export function allScreensLookBlank(sources: readonly Pick<ScreenSourceView, 'kind' | 'thumbnailDataUrl'>[]): boolean {
  const screens = sources.filter((s) => s.kind === 'screen')
  return screens.length > 0 && screens.every((s) => looksBlankThumbnail(s.thumbnailDataUrl))
}

/**
 * macOS-only decision: block the picker behind the permission explainer
 * instead of a grid of (possibly wallpaper-only, possibly literally blank)
 * thumbnails. Only ever consulted *after* `listSources()` has already run —
 * see the comment in `startShare` — never before an attempt.
 */
export function shouldShowPermissionPanel(
  isMacPlatform: boolean,
  permission: string,
  sources: readonly Pick<ScreenSourceView, 'kind' | 'thumbnailDataUrl'>[],
): boolean {
  if (!isMacPlatform) return false
  if (permission !== 'granted') return true
  return allScreensLookBlank(sources)
}

export async function startShare(conv: ConvId): Promise<void> {
  // Never gate on getMediaAccessStatus BEFORE attempting a capture: macOS only
  // lists an app under Privacy → Screen Recording once it has actually tried
  // to capture — the desktopCapturer enumeration inside `sources()` below IS
  // that attempt. Checking first sent people to a Settings pane where Chat
  // wasn't listed at all. Chat's own picker is used on every platform and
  // macOS version now (1.2) — no more native system-picker branch.
  const [{ sources }, permission] = await Promise.all([
    window.bridge.screen.sources(),
    window.bridge.screen.permission(),
  ])
  if (shouldShowPermissionPanel(window.bridge.platform === 'darwin', permission, sources)) {
    useScreenStore.setState({ permissionPanel: true })
    return
  }
  useScreenStore.setState({ pickerOpen: conv })
  // picker calls beginCapture(conv, source)
}

export async function beginCapture(
  conv: ConvId,
  source: Pick<ScreenSourceView, 'id' | 'name' | 'kind'> | null,
): Promise<void> {
  useScreenStore.setState({ pickerOpen: null })
  if (source) await window.bridge.screen.primeSource(source.id)
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: {
        frameRate: { ideal: RTC.captureMaxFps, max: RTC.captureMaxFps },
        width: { max: RTC.captureMaxWidth },
        height: { max: RTC.captureMaxHeight },
      },
    })
  } catch (err) {
    // Distinguish "user hit Cancel in the picker" from a real permission
    // block — cancelling must not throw a scary panel in their face.
    const name = err instanceof Error ? err.name : ''
    const perm = await window.bridge.screen.permission()
    const canceled = name === 'NotAllowedError' && perm === 'granted'
    if (!canceled && perm !== 'granted') useScreenStore.setState({ permissionPanel: true })
    return
  }
  const track = stream.getVideoTracks()[0]
  track.contentHint = 'detail'
  const settings = track.getSettings()
  const { sessionId, frameKey, nonceBase: nb } = await window.bridge.screen.start(
    conv,
    settings.width ?? 1280,
    settings.height ?? 720,
  )
  captureStream = stream
  frameCryptoKey = await importFrameKey(frameKey)
  nonceBase = b64ToBytes(nb)
  frameSeq = 0
  frameQuality = FRAME.quality
  useScreenStore.setState({
    sharing: {
      sessionId,
      conv,
      viewers: 0,
      liveViewers: 0,
      sourceName: source?.name ?? 'your screen',
      sourceKind: resolveSourceKind(source?.kind ?? 'screen', settings.displaySurface),
    },
  })
  await window.bridge.frames.watchViewers(sessionId, true)
  startFramePipeline(sessionId, stream)
  track.addEventListener('ended', () => void stopShare()) // OS-side revoke / stop
}

/**
 * `getSettings().displaySurface` reflects what was actually captured, which
 * is the ground truth if it disagrees with the source the user picked (e.g.
 * platform quirks around full-screen windows). Falls back to the picked
 * source's own kind when the browser doesn't report a surface.
 */
export function resolveSourceKind(pickedKind: 'screen' | 'window', displaySurface?: string): 'screen' | 'window' {
  if (displaySurface === 'monitor') return 'screen'
  if (displaySurface === 'window' || displaySurface === 'application' || displaySurface === 'browser') return 'window'
  return pickedKind
}

/** Presenter banner text — "Sharing Display 1" / "Sharing window: Xcode". */
export function presenterLabel(sourceName: string, sourceKind: 'screen' | 'window'): string {
  return sourceKind === 'screen' ? `Sharing ${sourceName}` : `Sharing window: ${sourceName}`
}

/** Stop the current share and reopen the picker for the same conversation. */
export async function switchSource(): Promise<void> {
  const conv = useScreenStore.getState().sharing?.conv
  if (!conv) return
  await stopShare()
  useScreenStore.setState({ pickerOpen: conv })
}

function startFramePipeline(sessionId: string, stream: MediaStream): void {
  const video = document.createElement('video')
  video.srcObject = stream
  video.muted = true
  void video.play().catch(() => {})
  let lastHash = ''

  frameTimer = setInterval(async () => {
    if (frameBusy || !frameCryptoKey || !nonceBase) return
    if (video.readyState < 2 || video.videoWidth === 0) return
    frameBusy = true
    try {
      const scale = Math.min(1, FRAME.maxEdgePx / Math.max(video.videoWidth, video.videoHeight))
      const w = Math.round(video.videoWidth * scale)
      const h = Math.round(video.videoHeight * scale)
      const canvas = new OffscreenCanvas(w, h)
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(video, 0, 0, w, h)

      // Skip-if-static: hash a 32x32 downsample
      const probe = new OffscreenCanvas(32, 32)
      probe.getContext('2d')!.drawImage(canvas, 0, 0, 32, 32)
      const probeData = probe.getContext('2d')!.getImageData(0, 0, 32, 32).data
      let hash = 0
      for (let i = 0; i < probeData.length; i += 16) hash = (hash * 31 + probeData[i]) >>> 0
      const hashStr = String(hash)
      if (hashStr === lastHash) return
      lastHash = hashStr

      let blob = await canvas.convertToBlob({ type: 'image/webp', quality: frameQuality })
      // Adaptive budget
      if (blob.size > FRAME.budgetBytes) {
        const idx = FRAME.qualitySteps.indexOf(frameQuality)
        if (idx < FRAME.qualitySteps.length - 1) frameQuality = FRAME.qualitySteps[idx + 1]
        blob = await canvas.convertToBlob({ type: 'image/webp', quality: frameQuality })
      } else if (blob.size < 120_000) {
        const idx = FRAME.qualitySteps.indexOf(frameQuality)
        if (idx > 0) frameQuality = FRAME.qualitySteps[idx - 1]
      }

      const plain = new Uint8Array(await blob.arrayBuffer())
      const seq = frameSeq++
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: frameIv(nonceBase, seq).buffer as ArrayBuffer },
        frameCryptoKey,
        plain.buffer as ArrayBuffer,
      )
      await window.bridge.frames.publish(sessionId, seq, new Uint8Array(ct))
    } catch {
      // dropped frame — next tick retries
    } finally {
      frameBusy = false
    }
  }, FRAME.intervalMs)
}

async function handleSignal(signal: RtcSignal): Promise<void> {
  const state = useScreenStore.getState()
  // Presenter: answer viewer offers
  if (signal.signal === 'offer' && state.sharing && signal.sessionId === state.sharing.sessionId) {
    if (presenterPcs.size >= RTC.meshMaxPeers) {
      await window.bridge.rtc.send({
        type: 'rtc',
        sessionId: signal.sessionId,
        purpose: 'screenshare',
        signal: 'busy',
        from: selfDeviceId(),
        to: signal.from,
      })
      return
    }
    if (!captureStream) return
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' })
    const track = captureStream.getVideoTracks()[0]
    const sender = pc.addTrack(track, captureStream)
    try {
      const params = sender.getParameters()
      params.degradationPreference = 'maintain-resolution'
      await sender.setParameters(params)
    } catch {
      // best-effort
    }
    presenterPcs.set(signal.from, pc)
    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        presenterPcs.delete(signal.from)
        bumpLiveViewers()
      } else if (pc.connectionState === 'connected') {
        bumpLiveViewers()
      }
    })
    await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp! })
    await pc.setLocalDescription(await pc.createAnswer())
    await waitGathering(pc)
    await window.bridge.rtc.send({
      type: 'rtc',
      sessionId: signal.sessionId,
      purpose: 'screenshare',
      signal: 'answer',
      from: selfDeviceId(),
      to: signal.from,
      sdp: pc.localDescription!.sdp,
    })
    return
  }
  // Presenter: viewer left
  if (signal.signal === 'bye' && state.sharing && signal.sessionId === state.sharing.sessionId) {
    presenterPcs.get(signal.from)?.close()
    presenterPcs.delete(signal.from)
    bumpLiveViewers()
    return
  }
  // Viewer: answer / busy from the presenter
  if (state.viewing && signal.sessionId === state.viewing.sessionId) {
    if (signal.signal === 'answer' && viewerPc) {
      try {
        await viewerPc.setRemoteDescription({ type: 'answer', sdp: signal.sdp! })
      } catch {
        fallbackToRelay()
      }
    } else if (signal.signal === 'busy') {
      fallbackToRelay()
    } else if (signal.signal === 'bye') {
      await leaveViewing() // presenter ended
    }
  }
}

function bumpLiveViewers(): void {
  const s = useScreenStore.getState().sharing
  if (!s) return
  const live = [...presenterPcs.values()].filter((pc) => pc.connectionState === 'connected').length
  useScreenStore.setState({ sharing: { ...s, liveViewers: live } })
}

export async function stopShare(): Promise<void> {
  const s = useScreenStore.getState().sharing
  if (!s) return
  if (frameTimer) clearInterval(frameTimer)
  frameTimer = null
  captureStream?.getTracks().forEach((t) => t.stop())
  captureStream = null
  for (const [to, pc] of presenterPcs) {
    pc.close()
    void window.bridge.rtc
      .send({ type: 'rtc', sessionId: s.sessionId, purpose: 'screenshare', signal: 'bye', from: selfDeviceId(), to, reason: 'ended' })
      .catch(() => {})
  }
  presenterPcs.clear()
  useScreenStore.setState({ sharing: null })
  await window.bridge.screen.stop(s.sessionId, s.conv).catch(() => {})
}

// ---------------------------------------------------------------------------
// Viewer

export async function watchSession(announce: ScreenshareAnnounce, conv: ConvId): Promise<void> {
  await leaveViewing()
  viewerFrameKey = await importFrameKey(announce.frameKey)
  viewerNonceBase = b64ToBytes(announce.nonceBase)
  useScreenStore.setState({
    viewing: {
      sessionId: announce.sessionId,
      conv,
      presenterDevice: announce.presenterDevice,
      mode: 'connecting',
      frameUrl: null,
      streamId: null,
    },
  })
  await window.bridge.rtc.setPollMode('fast')

  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' })
  viewerPc = pc
  pc.addTransceiver('video', { direction: 'recvonly' })
  pc.addEventListener('track', (ev) => {
    viewerStream = ev.streams[0] ?? new MediaStream([ev.track])
    const v = useScreenStore.getState().viewing
    if (v && v.sessionId === announce.sessionId) {
      clearViewerTimers()
      useScreenStore.setState({ viewing: { ...v, mode: 'p2p', streamId: viewerStream.id } })
    }
  })
  pc.addEventListener('connectionstatechange', () => {
    const v = useScreenStore.getState().viewing
    if (!v || v.sessionId !== announce.sessionId) return
    if (pc.connectionState === 'failed') fallbackToRelay()
    else if (pc.connectionState === 'disconnected') {
      viewerTimers.push(setTimeout(() => {
        if (pc.connectionState !== 'connected') fallbackToRelay()
      }, RTC.disconnectGraceMs))
    }
  })

  await pc.setLocalDescription(await pc.createOffer())
  await waitGathering(pc)
  await window.bridge.rtc.send({
    type: 'rtc',
    sessionId: announce.sessionId,
    purpose: 'screenshare',
    signal: 'offer',
    from: selfDeviceId(),
    to: announce.presenterDevice,
    sdp: pc.localDescription!.sdp,
  })

  // Fallback timers: no answer / never connects
  viewerTimers.push(
    setTimeout(() => {
      if (!pc.remoteDescription) fallbackToRelay()
    }, RTC.answerTimeoutMs),
    setTimeout(() => {
      if (pc.connectionState !== 'connected') fallbackToRelay()
    }, RTC.answerTimeoutMs + RTC.iceConnectTimeoutMs),
  )
}

function fallbackToRelay(): void {
  const v = useScreenStore.getState().viewing
  if (!v || v.mode === 'relay') return
  clearViewerTimers()
  viewerPc?.close()
  viewerPc = null
  void window.bridge.rtc
    .send({ type: 'rtc', sessionId: v.sessionId, purpose: 'screenshare', signal: 'bye', from: selfDeviceId(), to: v.presenterDevice, reason: 'fallback' })
    .catch(() => {})
  useScreenStore.setState({ viewing: { ...v, mode: 'relay', streamId: null } })
  void window.bridge.screen.join(v.sessionId)
}

async function handleFrame(sessionId: string, seq: number, bytes: Uint8Array): Promise<void> {
  const v = useScreenStore.getState().viewing
  if (!v || v.sessionId !== sessionId || v.mode !== 'relay' || !viewerFrameKey || !viewerNonceBase) return
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: frameIv(viewerNonceBase, seq).buffer as ArrayBuffer },
      viewerFrameKey,
      bytes.buffer as ArrayBuffer,
    )
    const url = URL.createObjectURL(new Blob([plain], { type: 'image/webp' }))
    if (lastFrameUrl) URL.revokeObjectURL(lastFrameUrl)
    lastFrameUrl = url
    const cur = useScreenStore.getState().viewing
    if (cur && cur.sessionId === sessionId) {
      useScreenStore.setState({ viewing: { ...cur, frameUrl: url } })
    }
  } catch {
    // frame from a different generation — skip
  }
}

export async function leaveViewing(): Promise<void> {
  const v = useScreenStore.getState().viewing
  if (!v) return
  clearViewerTimers()
  viewerPc?.close()
  viewerPc = null
  viewerStream = null
  if (lastFrameUrl) {
    URL.revokeObjectURL(lastFrameUrl)
    lastFrameUrl = null
  }
  void window.bridge.rtc
    .send({ type: 'rtc', sessionId: v.sessionId, purpose: 'screenshare', signal: 'bye', from: selfDeviceId(), to: v.presenterDevice, reason: 'ended' })
    .catch(() => {})
  await window.bridge.screen.leave(v.sessionId).catch(() => {})
  await window.bridge.rtc.setPollMode('idle').catch(() => {})
  useScreenStore.setState({ viewing: null })
}

function clearViewerTimers(): void {
  for (const t of viewerTimers) clearTimeout(t)
  viewerTimers = []
}

// ---------------------------------------------------------------------------

import { useStore } from '@/store'
import { selfOf } from '@/store'

function selfDeviceId(): string {
  return selfOf(useStore.getState().boot)?.deviceId ?? ''
}

/** Latest un-ended screenshare announce in a conversation's event log. */
export function activeAnnounceIn(events: VerifiedEvent[] | undefined): ScreenshareAnnounce | null {
  if (!events) return null
  let latest: ScreenshareAnnounce | null = null
  const ended = new Set<string>()
  for (const ev of events) {
    if (ev.type !== 'sys') continue
    const p = ev.payload as SysPayload
    if (p.kind === 'screenshare-ended') ended.add(String(p.data.sessionId))
    else if (p.kind === 'screenshare') latest = p.data as unknown as ScreenshareAnnounce
  }
  if (latest && !ended.has(latest.sessionId)) return latest
  return null
}
