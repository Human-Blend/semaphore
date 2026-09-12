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
  VotPayload,
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
  /** kind:'poll' (1.3): latest verified vote per device (option ids). */
  votes?: Record<string, string[]>
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

/**
 * How long after a poll's `closedAt` a vote is still counted (1.3). Covers a
 * vote that was already published when the author pressed Close; anything later
 * is a vote on a decision that has been announced, and is ignored.
 */
const VOTE_GRACE_MS = 5_000

/**
 * When a poll stopped taking votes, on the share clock, or null while it is
 * still open. Deliberately not `isPollClosed` from `./poll`: that one answers
 * "is it closed *now*" for a tile, and this one needs the instant itself.
 */
function closeTimeOf(poll: { closedAt?: number; closesAt?: number } | undefined): number | null {
  const ends = [poll?.closedAt, poll?.closesAt].filter(
    (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
  )
  return ends.length ? Math.min(...ends) : null
}

export function materialize(events: VerifiedEvent[], admins: string[] = []): MaterializedLog {
  const sorted = [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const messages = new Map<string, MessageView>()
  const sys: SysView[] = []
  // Mutation accumulators keyed by target — applied last-writer-wins by event id.
  // Edits are keyed by target *and author*: only the message's own author can
  // edit it, and keeping one slot per target let anyone on the share shadow the
  // author's latest edit by writing a later `edt` of their own — the apply step
  // then found a stranger's event, refused it, and silently dropped the real
  // edit with it. For a poll that meant a single unauthorized event re-opened a
  // closed poll (the `closedAt` body is an author `edt`, 1.3).
  const edits = new Map<string, Map<string, { id: string; body: MsgBody }>>()
  const dels = new Map<string, { id: string; by: string }>()
  const pins = new Map<string, { id: string; op: 'pin' | 'unpin' }>()
  const prvs = new Map<string, { id: string; preview: LinkPreview }>()
  const reactions = new Map<string, Map<string, { id: string; op: 'add' | 'remove' }>>() // target -> "emoji|device" -> latest
  // Poll votes (1.3): target -> device -> that device's votes. One vote per
  // *device*, last writer wins by event id; an empty choice is how a voter takes
  // it back.
  //
  // Per device, not per person: someone running Chat on a laptop and a desktop
  // counts twice, and neither client can tell that the two are one human (a
  // roster record is a device, and nothing binds devices to people). The team
  // treats device = person, which is also how reactions and read receipts have
  // always counted. The whole history per device is kept rather than just the
  // latest, because "what did this device have standing *before* the poll
  // closed" is a question the closing edit asks after the fact — see below.
  const votes = new Map<string, Map<string, { id: string; choice: string[] }[]>>()

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
        let m = edits.get(e.target)
        if (!m) edits.set(e.target, (m = new Map()))
        const prev = m.get(ev.author)
        if (!prev || prev.id <= ev.id) m.set(ev.author, { id: ev.id, body: e.body })
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
      // A poll vote (1.3). It is not a message, it is not a sys row, and it
      // carries no read-cursor weight: it only ever moves the numbers on the
      // poll tile of the message it targets.
      case 'vot': {
        const v = p as VotPayload
        let m = votes.get(v.target)
        if (!m) votes.set(v.target, (m = new Map()))
        const list = m.get(ev.author) ?? []
        list.push({ id: ev.id, choice: Array.isArray(v.choice) ? v.choice : [] })
        m.set(ev.author, list)
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

  // Apply mutations. An `edt` only ever counts from the message's own author,
  // so the one to apply is that author's latest — anyone else's is not a losing
  // edit, it is no edit at all, and it must not be able to hide theirs.
  for (const [target, byAuthor] of edits) {
    const m = messages.get(target)
    if (!m) continue
    const mine = byAuthor.get(m.authorDevice)
    if (!mine) continue
    m.body = mine.body
    m.edited = true
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
  // Poll votes: only onto a poll message that is still there. An empty choice
  // is a retraction, so it leaves no entry at all rather than an empty one —
  // "who voted" and "what they picked" stay the same question.
  //
  // A closed poll's result is final (1.3). `closedAt` is share-clock ms and an
  // event's stem starts with its HLC ms, so anything a device wrote after the
  // close is simply not part of the answer — including a retraction, which would
  // otherwise let a voter walk back a decision that had already been announced.
  // The vote that stood at closing time is the one that counts, so this reaches
  // back past the ignored events for it. The grace window is for votes that were
  // already in flight when the author pressed Close (a publish plus a beacon hop
  // is well under a second; 5 s is generous and still far from "an hour later").
  for (const [target, map] of votes) {
    const m = messages.get(target)
    if (!m || m.deleted || m.body.kind !== 'poll') continue
    // Both ways a poll closes count, and the earlier one wins when a poll has
    // both: the author's `closedAt`, and the deadline it was published with
    // (`closesAt`, which needs no event — `chat.vote` refuses on either).
    const closedAt = closeTimeOf(m.body.poll)
    const deadline = closedAt === null ? null : closedAt + VOTE_GRACE_MS
    const out: Record<string, string[]> = {}
    for (const [device, list] of map) {
      // Highest event id among the votes that landed in time: plain id-order
      // LWW, exactly like a reaction. A device whose clock runs behind its own
      // earlier vote therefore writes an event that never lands — the stem is
      // the only ordering anyone on the share can agree on.
      let latest: { id: string; choice: string[] } | null = null
      for (const v of list) {
        if (deadline !== null && hlcOf(v.id) > deadline) continue
        if (!latest || latest.id <= v.id) latest = v
      }
      if (latest && latest.choice.length > 0) out[device] = latest.choice
    }
    m.votes = out
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
