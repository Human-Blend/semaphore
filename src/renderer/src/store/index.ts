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
import type { ConvId, PresenceView, PrsStatus, PrView, VerifiedEvent } from '@shared/types'
import { TEAM_CONV } from '@shared/constants'

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
  /** Tracked Azure DevOps pull requests (pushed by the main-side PR service). */
  prs: PrView[]
  prsStatus: PrsStatus | null
  /** The PR group's settings dialog — opened from the pane header or the sidebar row. */
  prsPrefsOpen: boolean

  init(): Promise<void>
  /** Everything team-scoped: channels, people, own read marks; then every log for badges. */
  loadTeam(): Promise<void>
  setActiveConv(conv: ConvId | null): void
  /** Navigate to the PR group and open (or close) its settings dialog. */
  setPrsPrefsOpen(open: boolean): void
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
  prs: [],
  prsStatus: null,
  prsPrefsOpen: false,

  async init() {
    window.bridge.onPush((msg: PushMessage) => {
      const s = get()
      switch (msg.kind) {
        case 'boot':
          set({ boot: msg.boot })
          if (msg.boot.mode === 'ready') {
            // Unlock / onboarding land here: same default as a cold start.
            void get().loadTeam()
          } else if (msg.boot.mode === 'onboarding') {
            // Team disconnect (folder change): drop all team-scoped state.
            // The dock badge is cleared from here, not from PrAlert's effect:
            // this same render unmounts AppShell (and PrAlert with it), so an
            // effect keyed on the unseen count never gets to write the 0.
            void window.bridge.app.setBadge(0).catch(() => {})
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
              prs: [],
              prsStatus: null,
              prsPrefsOpen: false,
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
        case 'prs':
          set({ prs: msg.prs, prsStatus: msg.status })
          break
        case 'prs-open':
          get().setActiveConv(TEAM_CONV.prs)
          break
        case 'skew-warning':
          break
      }
    })

    const boot = await window.bridge.app.getBoot()
    set({ boot })
    const settings = await window.bridge.settings.get()
    set({ settings })
    if (boot.mode === 'ready') await get().loadTeam()
  },

  async loadTeam() {
    const [channels, presence, myReads] = await Promise.all([
      window.bridge.chat.channels(),
      window.bridge.presence.list(),
      window.bridge.chat.myReads(),
    ])
    set({ channels, presence, myReads })
    if (channels.length && !get().activeConv) get().setActiveConv(channels[0].conv)
    // Unread badges need every conversation's log, not just the open one; the
    // team logs (calendar, PR config) ride the same prefetch so the sidebar can
    // show a "something today" dot without opening the pane.
    for (const conv of [
      ...channels.map((c) => c.conv),
      ...presence.map((p) => p.dmConv),
      ...Object.values(TEAM_CONV),
    ])
      void get().ensureEvents(conv)
    // The PR service starts right after the chat service; a 'not-ready' here
    // just means we raced it and the first 'prs' push will fill the slice in.
    // Anything else is a real failure worth seeing in the console.
    try {
      const [prsStatus, prs] = await Promise.all([window.bridge.prs.status(), window.bridge.prs.list()])
      set({ prs, prsStatus })
    } catch (err) {
      if (!/not-ready/.test(String(err))) console.warn('prs: initial load failed', err)
    }
  },

  setActiveConv(conv) {
    // Leaving the PR group unmounts PrsPane — and the prefs modal with it —
    // without going through the modal's own close paths, so the flag has to be
    // dropped here or the next visit to team:prs opens the settings dialog
    // over the list unbidden.
    set(conv === TEAM_CONV.prs ? { activeConv: conv } : { activeConv: conv, prsPrefsOpen: false })
    if (conv) void get().ensureEvents(conv)
  },

  setPrsPrefsOpen(open) {
    if (open) get().setActiveConv(TEAM_CONV.prs)
    set({ prsPrefsOpen: open })
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
