import type {
  Attachment,
  ConvId,
  EdtPayload,
  DelPayload,
  GrpPayload,
  LinkPreview,
  MsgBody,
  MsgPayload,
  PinPayload,
  PrvPayload,
  RctPayload,
  SysPayload,
  VerifiedEvent,
} from './types'

// Reader-side merge of the append-only event log into renderable messages.
// Deterministic: same event set → same output, regardless of arrival order.
// Used by the renderer (and tests); pure code, no I/O.
//
// The 'cal' and 'prs' team-log event types are deliberately absent from the
// switch below: they never appear in a chan:/dm: log, and they materialize
// through calendar.ts / prs.ts instead. Falling through the switch drops them.

export interface ReactionView {
  emoji: string
  devices: string[] // deviceIds, insertion-ordered by event id
}

export interface MessageView {
  id: string
  conv: ConvId
  authorDevice: string
  authorName: string
  hlcMs: number
  sentWall: number
  senderSeq: number
  body: MsgBody
  replyTo?: string
  attachments: Attachment[]
  linkPreview?: LinkPreview
  edited: boolean
  deleted: boolean
  pinned: boolean
  verified: boolean
  reactions: ReactionView[]
}

export interface SysView {
  id: string
  conv: ConvId
  kind: SysPayload['kind']
  data: Record<string, unknown>
  authorDevice: string
  hlcMs: number
}

export interface MaterializedLog {
  messages: MessageView[] // sorted by event id (= HLC order)
  sys: SysView[]
  /** senderSeq gaps detected per device (possible deletions). */
  gaps: Record<string, number>
}

function hlcOf(stem: string): number {
  return Number(stem.slice(0, 13))
}

export function materialize(events: VerifiedEvent[], admins: string[] = []): MaterializedLog {
  const sorted = [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const messages = new Map<string, MessageView>()
  const sys: SysView[] = []
  // Mutation accumulators keyed by target — applied last-writer-wins by event id.
  const edits = new Map<string, { id: string; by: string; body: MsgBody }>()
  const dels = new Map<string, { id: string; by: string }>()
  const pins = new Map<string, { id: string; op: 'pin' | 'unpin' }>()
  const prvs = new Map<string, { id: string; preview: LinkPreview }>()
  const reactions = new Map<string, Map<string, { id: string; op: 'add' | 'remove' }>>() // target -> "emoji|device" -> latest

  const seqSeen = new Map<string, number[]>() // device -> senderSeqs

  for (const ev of sorted) {
    const p = ev.payload
    switch (p.t) {
      case 'msg': {
        const m = p as MsgPayload
        messages.set(ev.id, {
          id: ev.id,
          conv: m.conv,
          authorDevice: m.author.device,
          authorName: m.author.name,
          hlcMs: hlcOf(ev.id),
          sentWall: m.sentWall,
          senderSeq: m.senderSeq,
          body: m.body,
          replyTo: m.replyTo,
          attachments: m.attachments ?? [],
          linkPreview: m.linkPreview,
          edited: false,
          deleted: false,
          pinned: false,
          verified: ev.verified,
          reactions: [],
        })
        const list = seqSeen.get(m.author.device) ?? []
        list.push(m.senderSeq)
        seqSeen.set(m.author.device, list)
        break
      }
      case 'edt': {
        const e = p as EdtPayload
        edits.set(e.target, { id: ev.id, by: ev.author, body: e.body })
        break
      }
      case 'del': {
        const d = p as DelPayload
        dels.set(d.target, { id: ev.id, by: ev.author })
        break
      }
      case 'rct': {
        const r = p as RctPayload
        let m = reactions.get(r.target)
        if (!m) reactions.set(r.target, (m = new Map()))
        m.set(`${r.emoji}|${ev.author}`, { id: ev.id, op: r.op })
        break
      }
      case 'pin': {
        const pi = p as PinPayload
        pins.set(pi.target, { id: ev.id, op: pi.op })
        break
      }
      case 'prv': {
        const pr = p as PrvPayload
        const existing = prvs.get(pr.target)
        if (!existing || existing.id < ev.id) prvs.set(pr.target, { id: ev.id, preview: pr.linkPreview })
        break
      }
      case 'sys': {
        const s = p as SysPayload
        sys.push({ id: ev.id, conv: s.conv, kind: s.kind, data: s.data, authorDevice: ev.author, hlcMs: hlcOf(ev.id) })
        break
      }
      // Private-group notices in a DM log (1.2). They ride their own event type
      // so a 1.1 client never meets them at all, but for a 1.2 reader they are
      // just sys rows: same kinds, same `sysLine`, same conversation-vanished
      // handling. Key material in `data` is blanked at the bridge (shared/prs).
      case 'grp': {
        const g = p as GrpPayload
        sys.push({
          id: ev.id,
          conv: g.conv,
          kind: g.kind,
          data: g.data as unknown as Record<string, unknown>,
          authorDevice: ev.author,
          hlcMs: hlcOf(ev.id),
        })
        break
      }
    }
  }

  // Apply mutations
  for (const [target, e] of edits) {
    const m = messages.get(target)
    if (m && e.by === m.authorDevice) {
      m.body = e.body
      m.edited = true
    }
  }
  for (const [target, d] of dels) {
    const m = messages.get(target)
    if (m && (d.by === m.authorDevice || admins.includes(d.by))) {
      m.deleted = true
      m.body = { kind: 'text', text: '' }
      m.attachments = []
      m.linkPreview = undefined
    }
  }
  for (const [target, pi] of pins) {
    const m = messages.get(target)
    if (m) m.pinned = pi.op === 'pin'
  }
  for (const [target, pr] of prvs) {
    const m = messages.get(target)
    // Sender-embedded previews always win; prv only fills the gap.
    if (m && (!m.linkPreview || m.linkPreview.failed)) m.linkPreview = pr.preview
  }
  for (const [target, map] of reactions) {
    const m = messages.get(target)
    if (!m || m.deleted) continue
    const byEmoji = new Map<string, string[]>()
    for (const [key, v] of map) {
      if (v.op !== 'add') continue
      const [emoji, device] = key.split('|')
      const arr = byEmoji.get(emoji) ?? []
      arr.push(device)
      byEmoji.set(emoji, arr)
    }
    m.reactions = [...byEmoji.entries()].map(([emoji, devices]) => ({ emoji, devices }))
  }

  // senderSeq gap detection: within the retention window, holes in a device's
  // sequence mean messages disappeared without a tombstone.
  const gaps: Record<string, number> = {}
  for (const [device, seqs] of seqSeen) {
    const sortedSeqs = [...seqs].sort((a, b) => a - b)
    let missing = 0
    for (let i = 1; i < sortedSeqs.length; i++) {
      missing += Math.max(0, sortedSeqs[i] - sortedSeqs[i - 1] - 1)
    }
    if (missing > 0) gaps[device] = missing
  }

  return { messages: [...messages.values()], sys, gaps }
}
