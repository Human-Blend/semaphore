import { create } from 'zustand'
import type { ConvId, RtcSignal, ScreenshareAnnounce, SysPayload, VerifiedEvent } from '@shared/types'
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

interface ScreenState {
  sharing: { sessionId: string; conv: ConvId; viewers: number; liveViewers: number } | null
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

export async function startShare(conv: ConvId): Promise<void> {
  const perm = await window.bridge.screen.permission()
  if (perm === 'denied' || perm === 'restricted') {
    useScreenStore.setState({ permissionPanel: true })
    return
  }
  const { sources, systemPicker } = await window.bridge.screen.sources()
  if (!systemPicker && sources.length > 0) {
    useScreenStore.setState({ pickerOpen: conv })
    return // picker calls beginCapture(conv, sourceId)
  }
  await beginCapture(conv, null)
}

export async function beginCapture(conv: ConvId, sourceId: string | null): Promise<void> {
  useScreenStore.setState({ pickerOpen: null })
  if (sourceId) await window.bridge.screen.primeSource(sourceId)
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
  } catch {
    // User canceled the picker, or permission needs the app relaunched.
    const perm = await window.bridge.screen.permission()
    if (perm !== 'granted') useScreenStore.setState({ permissionPanel: true })
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
  useScreenStore.setState({ sharing: { sessionId, conv, viewers: 0, liveViewers: 0 } })
  await window.bridge.frames.watchViewers(sessionId, true)
  startFramePipeline(sessionId, stream)
  track.addEventListener('ended', () => void stopShare()) // OS-side revoke / stop
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
