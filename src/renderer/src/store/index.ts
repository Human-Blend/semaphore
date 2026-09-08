import { create } from 'zustand'
import type {
  BootMode,
  ChannelView,
  CursorView,
  HealthView,
  PushMessage,
  SendDraft,
  SettingsView,
  BeamOfferView,
  BeamProgressView,
  BlobFetchState,
  UpdateView,
} from '@shared/bridge'
import type { ConvId, PresenceView, VerifiedEvent } from '@shared/types'

// Central renderer state. Raw events per conversation live here; components
// materialize views with @shared/merge (memoized). All mutations go through
// bridge calls; pushes from main flow into this store.

export interface TypingMap {
  [deviceId: string]: number // until (share-clock ms)
}

interface ChatStore {
  boot: BootMode | null
  channels: ChannelView[]
  presence: PresenceView[]
  events: Record<string, VerifiedEvent[]> // conv -> raw events (sorted on insert)
  eventsLoaded: Record<string, boolean>
  typing: Record<string, TypingMap>
  cursors: Record<string, Record<string, CursorView>>
  myReads: Record<string, string> // conv -> my read stem (local mirror)
  health: HealthView
  outboxQueued: number
  activeConv: ConvId | null
  settings: SettingsView | null
  beamOffers: BeamOfferView[]
  beamProgress: Record<string, BeamProgressView>
  blobs: Record<string, BlobFetchState>
  update: UpdateView | null
  lightbox: { conv: ConvId; eventId: string; blobId: string } | null

  init(): Promise<void>
  setActiveConv(conv: ConvId | null): void
  ensureEvents(conv: ConvId): Promise<void>
  send(conv: ConvId, draft: SendDraft): Promise<void>
  markRead(conv: ConvId, stem: string): void
  unreadCount(conv: ConvId): number
  openLightbox(v: { conv: ConvId; eventId: string; blobId: string } | null): void
  refreshSettings(): Promise<void>
}

function insertEvent(list: VerifiedEvent[], ev: VerifiedEvent): VerifiedEvent[] {
  if (list.some((e) => e.id === ev.id)) return list
  const next = [...list, ev]
  next.sort((a, b) => (a.id < b.id ? -1 : 1))
  return next
}

export const useStore = create<ChatStore>((set, get) => ({
  boot: null,
  channels: [],
  presence: [],
  events: {},
  eventsLoaded: {},
  typing: {},
  cursors: {},
  myReads: {},
  health: { reachable: true, latencyMs: null },
  outboxQueued: 0,
  activeConv: null,
  settings: null,
  beamOffers: [],
  beamProgress: {},
  blobs: {},
  update: null,
  lightbox: null,

  async init() {
    window.bridge.onPush((msg: PushMessage) => {
      const s = get()
      switch (msg.kind) {
        case 'boot':
          set({ boot: msg.boot })
          if (msg.boot.mode === 'ready') {
            void window.bridge.chat.channels().then((channels) => set({ channels }))
            void window.bridge.presence.list().then((presence) => set({ presence }))
          } else if (msg.boot.mode === 'onboarding') {
            // Team disconnect (folder change): drop all team-scoped state.
            set({
              channels: [],
              presence: [],
              events: {},
              eventsLoaded: {},
              typing: {},
              cursors: {},
              myReads: {},
              activeConv: null,
              beamOffers: [],
              beamProgress: {},
              blobs: {},
              update: null,
              lightbox: null,
              outboxQueued: 0,
            })
          }
          break
        case 'event':
          set({ events: { ...s.events, [msg.conv]: insertEvent(s.events[msg.conv] ?? [], msg.event) } })
          break
        case 'channels':
          set({ channels: msg.channels })
          break
        case 'presence':
          set({ presence: msg.views })
          break
        case 'typing': {
          const conv = s.typing[msg.conv] ?? {}
          set({ typing: { ...s.typing, [msg.conv]: { ...conv, [msg.deviceId]: msg.until } } })
          break
        }
        case 'cursors': {
          const conv = s.cursors[msg.conv] ?? {}
          set({ cursors: { ...s.cursors, [msg.conv]: { ...conv, [msg.deviceId]: msg.cursor } } })
          break
        }
        case 'health':
          set({ health: msg.health })
          break
        case 'outbox':
          set({ outboxQueued: msg.queued })
          break
        case 'beam-offer':
          set({ beamOffers: [...s.beamOffers.filter((o) => o.dropId !== msg.offer.dropId), msg.offer] })
          break
        case 'beam-progress':
          set({ beamProgress: { ...s.beamProgress, [msg.progress.dropId]: msg.progress } })
          break
        case 'blob':
          set({ blobs: { ...s.blobs, [msg.state.blobId]: msg.state } })
          break
        case 'update':
          set({ update: msg.update })
          break
        case 'skew-warning':
          break
      }
    })

    const boot = await window.bridge.app.getBoot()
    set({ boot })
    const settings = await window.bridge.settings.get()
    set({ settings })
    if (boot.mode === 'ready') {
      const [channels, presence] = await Promise.all([
        window.bridge.chat.channels(),
        window.bridge.presence.list(),
      ])
      set({ channels, presence })
      if (channels.length && !get().activeConv) get().setActiveConv(channels[0].conv)
    }
  },

  setActiveConv(conv) {
    set({ activeConv: conv })
    if (conv) void get().ensureEvents(conv)
  },

  async ensureEvents(conv) {
    if (get().eventsLoaded[conv]) return
    const list = await window.bridge.chat.events(conv)
    list.sort((a, b) => (a.id < b.id ? -1 : 1))
    set((s) => ({
      events: { ...s.events, [conv]: list },
      eventsLoaded: { ...s.eventsLoaded, [conv]: true },
    }))
    const cursors = await window.bridge.chat.cursors(conv)
    set((s) => ({ cursors: { ...s.cursors, [conv]: cursors } }))
  },

  async send(conv, draft) {
    await window.bridge.chat.send(conv, draft)
  },

  markRead(conv, stem) {
    const prev = get().myReads[conv] ?? ''
    if (stem <= prev) return
    set((s) => ({ myReads: { ...s.myReads, [conv]: stem } }))
    void window.bridge.chat.markRead(conv, stem)
  },

  unreadCount(conv) {
    const s = get()
    const read = s.myReads[conv] ?? ''
    const events = s.events[conv] ?? []
    const selfId = s.boot?.mode === 'ready' ? s.boot.self.deviceId : ''
    return events.filter((e) => e.type === 'msg' && e.id > read && e.author !== selfId).length
  },

  openLightbox(v) {
    set({ lightbox: v })
  },

  async refreshSettings() {
    set({ settings: await window.bridge.settings.get() })
  },
}))

export function selfOf(boot: BootMode | null) {
  return boot?.mode === 'ready' ? boot.self : null
}
