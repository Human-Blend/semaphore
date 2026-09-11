import { randomBytes } from 'node:crypto'
import type { GroupView } from '@shared/bridge'
import { DIR, KID } from '@shared/constants'
import { isDmConv, isGrpConv } from '@shared/ids'
import type {
  ConvId,
  GroupInviteData,
  GroupRemovedData,
  GrpPayload,
  SysPayload,
  VerifiedEvent,
} from '@shared/types'
import { groupDirToken, newGroupKey } from '../crypto/keys'
import type { EventStore } from '../transport/events'
import type { ConvInfo, GroupKeyLookup, GroupProvider, Session } from '../transport/session'

// Private groups (1.2). A group is a random 32-byte key and nothing else: the
// key is handed to each member as a `group-invite` sys event inside the
// owner↔member DM log (already end-to-end encrypted, already polled — no new
// share I/O and no membership leak in any filename), and the log lives under
// `groups/<HMAC(key1,'grp-dirtoken')>/events`, a directory a non-member cannot
// even compute. Removing someone rotates the key to a new epoch; the epoch
// rides in each record's kid so a reader knows which key a file wants.
//
// Nothing about a group is discoverable from the share: state lives locally,
// wrapped by the LMK in the team-scoped secret store.

const GROUPS_SECRET = 'groups'

/** Longest name a group may carry. */
export const GROUP_NAME_MAX = 40

export function normalizeGroupName(input: string): string {
  return input.trim().replace(/\s+/g, ' ').slice(0, GROUP_NAME_MAX)
}

/**
 * Everything this device knows about one group. `base` is the authoritative
 * snapshot that came with our invite (or our own creation): log events older
 * than `base.stem` are already folded into it, so the fold ignores them —
 * which is what keeps a member invited at epoch 3 from "re-adding" someone the
 * owner removed at epoch 2 in a record they will never be able to read.
 */
export interface GroupState {
  groupId: string
  owner: string
  token: string
  createdAt: number
  base: { name: string; members: string[]; stem: string }
  /** Folded from the group log (cached for display and for authorization). */
  name: string
  members: string[]
  /** Highest epoch we hold a key for — the one we write under. */
  epoch: number
  /** epoch -> base64 32-byte key. */
  keys: Record<string, string>
  /** epoch -> event id of the removal that retired the previous key (see foldGroupLog). */
  rotations: Record<string, string>
  deletedAt?: number
  /** We left, or the owner removed us: hidden everywhere, keys kept until the janitor. */
  left?: boolean
}

export interface GroupFoldResult {
  name: string
  members: string[]
  deletedAt?: number
  /** Highest epoch named by an authorized removal we could read. */
  epoch: number
  /**
   * Epoch → event id of the removal that introduced it. A record written under
   * an older key *after* that point is a former member still typing: the
   * rotation stopped them reading, and this is what stops them being read.
   */
  rotations: Record<string, string>
}

/**
 * Fold a group's log. Authorization is evaluated *at that point of the fold*:
 * `group-renamed` / `group-left` count when the author is a member right then,
 * `group-members-added` / `group-member-removed` / `group-deleted` only when
 * the author is the owner. Anything else is ignored — an unauthorized
 * tombstone must not delete a group for everyone, and an unauthorized add must
 * not put anyone on a list they can never hold a key for.
 */
export function foldGroupLog(
  base: { owner: string; name: string; members: string[]; stem: string },
  events: VerifiedEvent[],
): GroupFoldResult {
  const members = new Set(base.members)
  members.add(base.owner)
  let name = base.name
  let deletedAt: number | undefined
  let epoch = 1
  const rotations: Record<string, string> = {}

  const sorted = events
    .filter((e) => e.type === 'sys' && e.verified && e.id > base.stem)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  for (const ev of sorted) {
    const p = ev.payload as SysPayload
    const data = p.data ?? {}
    const isOwner = ev.author === base.owner
    const isMember = members.has(ev.author)
    switch (p.kind) {
      case 'group-created':
        if (!isOwner) break
        if (typeof data.name === 'string' && data.name) name = data.name
        for (const m of stringList(data.members)) members.add(m)
        break
      case 'group-renamed':
        if (!isMember) break
        if (typeof data.name === 'string' && data.name.trim()) name = normalizeGroupName(data.name)
        break
      case 'group-members-added':
        // Owner only, like every other membership change (1.2 review): an
        // invite is only ever adopted from the group's owner, so an add by
        // anyone else could not deliver a key anyway — all it could do is pad
        // this list with people who will never hold one.
        if (!isOwner) break
        for (const m of stringList(data.members)) members.add(m)
        break
      case 'group-member-removed': {
        if (!isOwner) break
        if (typeof data.member === 'string' && data.member !== base.owner) members.delete(data.member)
        if (typeof data.epoch === 'number' && data.epoch > 1) {
          const at = rotations[String(data.epoch)]
          if (!at || ev.id < at) rotations[String(data.epoch)] = ev.id
          if (data.epoch > epoch) epoch = data.epoch
        }
        break
      }
      case 'group-left':
        if (!isMember) break
        members.delete(ev.author)
        break
      case 'group-deleted':
        if (!isOwner) break
        if (deletedAt === undefined) deletedAt = Number(ev.id.slice(0, 13)) || Date.now()
        break
      default:
        break
    }
  }
  return { name, members: [...members], deletedAt, epoch, rotations }
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x)) : []
}

/** What GroupService needs from ChatService (kept narrow so tests can stand in). */
export interface GroupHost {
  readonly events: EventStore
  /** Ring the published file into the beacon so peers ingest it without a scan. */
  noteOwnEvent(conv: ConvId, fileName: string): void
  pushGroups(): void
}

const KID_RE = /^grp\/([0-9A-Z]{20})\/e(\d+)$/

/**
 * How many epochs above the newest key we hold a record may claim and still be
 * parked. A rotation is one epoch and its rekey DM is already on the share, so
 * even a badly lagging reader is a couple of epochs behind at most; anything
 * beyond this is a kid nobody will ever hand us a key for.
 */
const MAX_EPOCH_LOOKAHEAD = 8

export class GroupService implements GroupProvider {
  private states = new Map<string, GroupState>() // groupId -> state
  private byToken = new Map<string, string>() // dir token -> groupId
  private keyCache = new Map<string, Buffer>() // `${groupId}/${epoch}` -> key
  /** Serializes the async work kicked off from the (synchronous) event listener. */
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private session: Session,
    private host: GroupHost,
  ) {
    this.load()
    session.groups = this
  }

  // -------------------------------------------------------------------------
  // Persistence

  private load(): void {
    const saved = this.session.store.readSecretJson<GroupState[]>(GROUPS_SECRET) ?? []
    for (const s of saved) {
      if (!s || typeof s.groupId !== 'string' || typeof s.token !== 'string') continue
      this.states.set(s.groupId, s)
      this.byToken.set(s.token, s.groupId)
    }
  }

  private save(): void {
    this.session.store.writeSecretJson(GROUPS_SECRET, [...this.states.values()])
  }

  private drop(groupId: string): void {
    const st = this.states.get(groupId)
    if (st) this.byToken.delete(st.token)
    this.states.delete(groupId)
    for (const k of [...this.keyCache.keys()]) if (k.startsWith(`${groupId}/`)) this.keyCache.delete(k)
    this.save()
  }

  // -------------------------------------------------------------------------
  // GroupProvider — the session's `grp:` seam

  private stateFor(conv: ConvId): GroupState | null {
    if (!isGrpConv(conv)) return null
    return this.states.get(conv.slice(4)) ?? null
  }

  private live(conv: ConvId): GroupState | null {
    const st = this.stateFor(conv)
    return st && !st.deletedAt && !st.left ? st : null
  }

  private keyFor(state: GroupState, epoch: number): Buffer | null {
    const cacheKey = `${state.groupId}/${epoch}`
    const hit = this.keyCache.get(cacheKey)
    if (hit) return hit
    const b64 = state.keys[String(epoch)]
    if (!b64) return null
    const buf = Buffer.from(b64, 'base64')
    if (buf.length !== 32) return null
    this.keyCache.set(cacheKey, buf)
    return buf
  }

  /**
   * Remember when an epoch took over: either the removal event that created it
   * (from the fold) or, for a member who cannot read that event, the invite or
   * rekey that told us we are on it. Earliest wins, and it is never forgotten —
   * this is the line that separates a former member's history from their
   * writes after they were removed.
   */
  private noteRotation(state: GroupState, epoch: number, stem: string): void {
    if (epoch <= 1 || !stem) return
    const at = state.rotations[String(epoch)]
    if (!at || stem < at) state.rotations[String(epoch)] = stem
  }

  private maxEpoch(state: GroupState): number {
    let max = 0
    for (const e of Object.keys(state.keys)) max = Math.max(max, Number(e) || 0)
    return max
  }

  info(conv: ConvId): ConvInfo | null {
    const st = this.live(conv)
    if (!st) return null
    const key = this.keyFor(st, st.epoch)
    if (!key) return null
    return {
      key,
      eventsDir: `${DIR.groups}/${st.token}/events`,
      kid: KID.grp(st.token, st.epoch),
      scope: 'grp',
    }
  }

  /**
   * The moment a record's key stopped being current, when that record is a
   * former member's write under a retired epoch — else null, meaning "nothing
   * to check". Their history from before the rotation still opens; only what
   * they wrote *after* it is refused.
   *
   * This returns the cut rather than a verdict because the verdict cannot be
   * reached from the record alone: the filename stem is chosen by its writer,
   * so a removed device can back-date one and walk straight past a stem
   * comparison. The caller compares the file's own mtime instead (events.ts).
   */
  staleWriteCut(conv: ConvId, kid: string, author: string): string | null {
    const st = this.stateFor(conv)
    if (!st) return null
    const m = KID_RE.exec(kid)
    if (!m) return null
    const epoch = Number(m[2])
    if (epoch >= this.maxEpoch(st)) return null // current key: nothing to say
    if (st.members.includes(author)) return null // a member writing late is fine
    let cut: string | null = null
    for (const [e, at] of Object.entries(st.rotations)) {
      if (Number(e) > epoch && (cut === null || at < cut)) cut = at
    }
    return cut
  }

  /** Is this device in the group's folded membership? (Beacon sections, 1.2.) */
  isMember(conv: ConvId, deviceId: string): boolean {
    return this.stateFor(conv)?.members.includes(deviceId) ?? false
  }

  keyForKid(conv: ConvId, kid: string): GroupKeyLookup {
    const st = this.stateFor(conv)
    if (!st) return { kind: 'reject' }
    const m = KID_RE.exec(kid)
    if (!m || m[1] !== st.token) return { kind: 'reject' }
    const epoch = Number(m[2])
    const key = this.keyFor(st, epoch)
    if (key) return { kind: 'key', key }
    // Higher than anything we hold: the rekey DM carrying it may still be in
    // flight, so park. A *lower* unknown epoch is a gap we were never given a
    // key for (invited after that rotation) — no key will ever arrive for it.
    // An epoch far above ours is nobody's rekey in flight: it is a made-up kid,
    // and parking on it would let one writer fill this device's parking lot.
    const max = this.maxEpoch(st)
    return epoch > max && epoch <= max + MAX_EPOCH_LOOKAHEAD ? { kind: 'unknown-epoch' } : { kind: 'reject' }
  }

  token(conv: ConvId): string | null {
    return this.live(conv)?.token ?? null
  }

  convForToken(token: string): ConvId | null {
    const groupId = this.byToken.get(token)
    if (!groupId) return null
    const st = this.states.get(groupId)
    return st && !st.deletedAt && !st.left ? (`grp:${groupId}` as ConvId) : null
  }

  keys(conv: ConvId): Buffer[] {
    const st = this.stateFor(conv)
    if (!st) return []
    return Object.keys(st.keys)
      .map(Number)
      .sort((a, b) => b - a)
      .map((e) => this.keyFor(st, e))
      .filter((k): k is Buffer => !!k)
  }

  convs(): ConvId[] {
    return [...this.states.values()]
      .filter((s) => !s.deletedAt && !s.left)
      .map((s) => `grp:${s.groupId}` as ConvId)
  }

  // -------------------------------------------------------------------------
  // Views

  views(): GroupView[] {
    return [...this.states.values()]
      .filter((s) => !s.deletedAt && !s.left)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => this.viewOf(s))
  }

  private viewOf(s: GroupState): GroupView {
    return {
      conv: `grp:${s.groupId}`,
      groupId: s.groupId,
      name: s.name,
      owner: s.owner,
      members: [...s.members],
      epoch: s.epoch,
      role: s.owner === this.session.deviceId ? 'owner' : 'member',
    }
  }

  /** Display name for notifications and toasts; null when we don't know the group. */
  nameOf(conv: ConvId): string | null {
    return this.stateFor(conv)?.name ?? null
  }

  /** Dirs whose tombstone the janitor may remove once the grace period passes. */
  deletedDirs(): { rel: string; deletedAt: number }[] {
    return [...this.states.values()]
      .filter((s) => s.deletedAt)
      .map((s) => ({ rel: `${DIR.groups}/${s.token}`, deletedAt: s.deletedAt! }))
  }

  // -------------------------------------------------------------------------
  // Startup

  /** Catch every live group up from the share (called once, from ChatService.start). */
  async catchUpAll(): Promise<void> {
    for (const conv of this.convs()) {
      await this.host.events.catchUp(conv)
      this.refold(conv)
    }
  }

  /** Await whatever the event listener kicked off (tests, shutdown). */
  settle(): Promise<void> {
    return this.chain
  }

  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch(() => {})
  }

  // -------------------------------------------------------------------------
  // Ingest

  /**
   * Called for every ingested or published event. Two jobs: act on the `grp`
   * notices that travel in a DM log (key material from an invite or rekey, and
   * the owner telling us we were removed), and refold a group's own log when
   * one of its `sys` events lands.
   */
  onEvent(conv: ConvId, event: VerifiedEvent): void {
    if (!event.verified) return
    if (isDmConv(conv)) {
      if (event.type !== 'grp') return
      const p = event.payload as GrpPayload
      // Only the DM peer can hand us any of this: our own copy of the invite we
      // sent is not news, and a payload signed by anyone else is not this DM.
      const peer = this.session.dmsByToken.get(conv.slice(3))?.peerDeviceId
      if (!peer || event.author !== peer) return
      if (p.kind === 'group-removed') {
        // Through the same queue as the invites: a removal that overtook an
        // invite still sitting in it would find no state to drop and the invite
        // would then re-adopt a group we are no longer in.
        this.enqueue(async () => this.acceptRemoval(event.author, p.data as GroupRemovedData))
        return
      }
      if (p.kind !== 'group-invite' && p.kind !== 'group-rekey') return
      const data = p.data as GroupInviteData
      this.enqueue(() => this.acceptKeys(p.kind === 'group-rekey', event.author, event.id, data))
      return
    }
    if (event.type !== 'sys' || !isGrpConv(conv)) return
    if (this.refold(conv)) this.host.pushGroups()
  }

  /**
   * The owner told us, over our DM with them, that they removed us (1.2). The
   * removal event in the group's own log is written under the new epoch key
   * precisely so we cannot read it, so without this notice the group would just
   * go quiet forever. Drop it exactly as `leave()` does, minus the publish —
   * there is nothing left we may write into.
   *
   * Both halves of the authorization matter: the author has to be the group's
   * owner *and* the peer on the other end of this DM, so nobody can evict
   * anyone from a group by writing into a DM of their own.
   */
  private acceptRemoval(author: string, data: GroupRemovedData): void {
    if (!data || typeof data !== 'object' || typeof data.groupId !== 'string') return
    const st = this.states.get(data.groupId)
    if (!st || st.owner !== author) return
    if (st.owner === this.session.deviceId) return // an owner cannot remove themselves
    this.host.events.forget(`grp:${st.groupId}`)
    this.drop(st.groupId)
    this.host.pushGroups()
  }

  /**
   * Adopt key material from a DM invite/rekey. Everything is validated before
   * it touches state: a group we hold is only ever moved *forward* (a higher
   * epoch, from its own owner), never re-pointed at a different directory.
   */
  private async acceptKeys(rekey: boolean, author: string, stem: string, data: GroupInviteData): Promise<void> {
    if (!data || typeof data !== 'object') return
    const { groupId, owner, epoch } = data
    if (typeof groupId !== 'string' || !/^[0-9a-f]{8}$/.test(groupId)) return
    if (typeof owner !== 'string' || !/^[0-9a-f]{32}$/.test(owner)) return
    if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 1) return
    const key = decodeKey(data.key)
    if (!key) return
    const key1 = epoch === 1 ? key : decodeKey(data.key1)
    if (!key1) return // without the epoch-1 key we cannot even name the directory
    const token = groupDirToken(key1)
    const name = normalizeGroupName(typeof data.name === 'string' ? data.name : '') || 'Private group'
    const members = stringList(data.members)
    if (!members.includes(owner)) members.push(owner)
    if (!members.includes(this.session.deviceId)) return // not an invite for us

    const conv: ConvId = `grp:${groupId}`
    const existing = this.states.get(groupId)
    if (existing) {
      if (existing.token !== token || existing.owner !== owner) return // not the same group
      const known = this.maxEpoch(existing)
      // Only the owner rotates: a member announcing a *new* epoch would strand
      // us writing under a key nobody else has. Re-sending the epoch we already
      // hold is harmless whoever sends it (same epoch, same key, checked below)
      // — but only the owner's copy is ever believed about anything else.
      if ((rekey || epoch > known) && author !== existing.owner) return
      if (epoch < known) return
      if (epoch === known && existing.keys[String(epoch)] !== data.key) return // same epoch, different key
      existing.keys[String(epoch)] = key.toString('base64')
      existing.keys['1'] = key1.toString('base64')
      if (epoch > known) this.noteRotation(existing, epoch, stem)
      existing.epoch = this.maxEpoch(existing)
      // A newer snapshot supersedes ours: it already reflects every mutation
      // that happened before it, including ones we can no longer read. Only the
      // owner's, though — a member's "add people" invite carries whatever
      // membership *their* client folded, and taking it as the base would
      // re-admit anyone the owner removed since (and undo a rename, and roll
      // back a name) on the say-so of someone with no authority over either.
      // A member's invite is key material and nothing else.
      if (author === existing.owner && stem > existing.base.stem) {
        existing.base = { name, members, stem }
      }
      existing.left = undefined
      this.save()
    } else {
      if (rekey) return // a rekey for a group we never joined tells us nothing
      if (!members.includes(author)) return // the inviter has to be in the group
      // Adopting a group means adopting its owner, and the owner is the one
      // authority in the whole fold — the only device whose removals and
      // tombstones count. Nothing on the share proves who that is, so the only
      // claim we accept is a device's claim about itself: the invite that
      // creates a group here must be signed by the owner it names. That is also
      // why `addMembers` is owner-only: an invite from anyone else would be
      // refused right here, and the caller would never know.
      if (owner !== author) return
      if (this.byToken.has(token)) return // token collision with another group
      const state: GroupState = {
        groupId,
        owner,
        token,
        createdAt: typeof data.createdAt === 'number' ? data.createdAt : Number(stem.slice(0, 13)) || Date.now(),
        base: { name, members, stem },
        name,
        members,
        epoch,
        // Invited straight into epoch N: everything under an older key that is
        // stamped after this invite is someone writing with a retired key.
        rotations: epoch > 1 ? { [String(epoch)]: stem } : {},
        keys: epoch === 1 ? { '1': key.toString('base64') } : { '1': key1.toString('base64'), [String(epoch)]: key.toString('base64') },
      }
      this.states.set(groupId, state)
      this.byToken.set(token, groupId)
      this.save()
    }

    // New key → whatever was parked under it can be read now.
    await this.host.events.replayParked(conv).catch(() => 0)
    await this.host.events.catchUp(conv).catch(() => 0)
    this.refold(conv)
    this.host.pushGroups()
  }

  /**
   * Recompute a group's folded name/members/tombstone from its log. Returns
   * whether anything the renderer can see changed.
   */
  refold(conv: ConvId): boolean {
    const st = this.stateFor(conv)
    if (!st) return false
    const before = JSON.stringify([st.name, st.members, st.deletedAt ?? 0, st.left ?? false, st.epoch])
    const folded = foldGroupLog(
      { owner: st.owner, name: st.base.name, members: st.base.members, stem: st.base.stem },
      this.host.events.getEvents(conv),
    )
    st.name = folded.name
    st.members = folded.members
    for (const [e, at] of Object.entries(folded.rotations)) this.noteRotation(st, Number(e), at)
    st.epoch = this.maxEpoch(st)
    if (folded.deletedAt) st.deletedAt = folded.deletedAt
    if (!folded.members.includes(this.session.deviceId)) st.left = true
    const after = JSON.stringify([st.name, st.members, st.deletedAt ?? 0, st.left ?? false, st.epoch])
    if (before === after) return false
    if (st.deletedAt || st.left) this.host.events.forget(conv)
    this.save()
    return true
  }

  // -------------------------------------------------------------------------
  // Commands (bridge.groups.*)

  async create(name: string, members: string[]): Promise<GroupView> {
    const clean = normalizeGroupName(name)
    if (!clean) throw new Error('invalid-name')
    const self = this.session.deviceId
    const peers = [...new Set(members)].filter((m) => m !== self)
    for (const m of peers) {
      const entry = this.session.roster.get(m)
      if (!entry?.record.xPub) throw new Error('unknown-member')
    }
    const groupId = randomBytes(4).toString('hex')
    const key1 = newGroupKey()
    const token = groupDirToken(key1)
    const state: GroupState = {
      groupId,
      owner: self,
      token,
      createdAt: this.session.io.calibratedNow(),
      base: { name: clean, members: [self, ...peers], stem: '' },
      name: clean,
      members: [self, ...peers],
      epoch: 1,
      rotations: {},
      keys: { '1': key1.toString('base64') },
    }
    this.states.set(groupId, state)
    this.byToken.set(token, groupId)
    this.save()

    const conv: ConvId = `grp:${groupId}`
    try {
      await this.publishSys(conv, 'group-created', { name: clean, members: state.members })
    } catch (err) {
      // The log never opened: a group nobody can see is worse than no group.
      this.drop(groupId)
      throw err
    }
    this.host.pushGroups()
    // An invite that fails leaves the group standing — the key is already on
    // the share for whoever did get theirs, and "Add people" re-sends the rest.
    // Every remaining invite is still attempted: one unreachable DM must not
    // cost the other four people theirs.
    const failed: string[] = []
    for (const m of peers) {
      try {
        await this.sendInvite(m, state, false)
      } catch {
        failed.push(m)
      }
    }
    if (failed.length > 0) {
      // The group exists and is already in the sidebar (pushGroups above), so
      // this must not read as "nothing happened": it names what is missing and
      // the one action that fixes it.
      throw new GroupPartialError(this.viewOf(state), failed)
    }
    return this.viewOf(state)
  }

  async rename(conv: ConvId, name: string): Promise<void> {
    const st = this.requireMember(conv)
    const clean = normalizeGroupName(name)
    if (!clean) throw new Error('invalid-name')
    if (clean === st.name) return
    await this.publishSys(conv, 'group-renamed', { name: clean })
    this.refold(conv)
    this.host.pushGroups()
  }

  /**
   * Owner only. Membership is owner-managed end to end (1.2 review): a
   * newcomer's client only adopts an invite signed by the group's owner —
   * nothing on the share proves who owns a group, so a device's claim about
   * itself is the only one worth anything — which would make a member's "Add
   * people" a request that silently went nowhere. So it is refused here, and
   * the fold ignores a `group-members-added` from anyone but the owner.
   */
  async addMembers(conv: ConvId, members: string[]): Promise<void> {
    const st = this.requireMember(conv)
    if (st.owner !== this.session.deviceId) throw new Error('not-owner')
    const requested = [...new Set(members)].filter((m) => m !== this.session.deviceId)
    for (const m of requested) {
      const entry = this.session.roster.get(m)
      if (!entry?.record.xPub) throw new Error('unknown-member')
    }
    if (requested.length === 0) return
    const fresh = requested.filter((m) => !st.members.includes(m))
    if (fresh.length > 0) {
      await this.publishSys(conv, 'group-members-added', { members: fresh })
      this.refold(conv)
    }
    // Everyone asked for gets an invite, including someone already listed: that
    // is how someone whose invite failed the first time — or whose rekey did —
    // finally gets the current key. A duplicate invite is a no-op on the
    // receiver (same epoch, same key).
    for (const m of requested) await this.sendInvite(m, st, false)
    this.host.pushGroups()
  }

  /**
   * Owner only. The removal is what rotates the key: the new epoch key goes to
   * everyone *but* the removed device, and the removal event itself is written
   * under it — so the person being removed cannot even read that it happened.
   */
  async removeMember(conv: ConvId, member: string): Promise<void> {
    const st = this.requireMember(conv)
    if (st.owner !== this.session.deviceId) throw new Error('not-owner')
    if (member === st.owner) throw new Error('cannot-remove-owner')
    if (!st.members.includes(member)) return

    const prevEpoch = st.epoch
    const prevMembers = st.members
    const nextEpoch = this.maxEpoch(st) + 1
    st.keys[String(nextEpoch)] = newGroupKey().toString('base64')
    st.epoch = nextEpoch
    // `members` is set eagerly so the rekey below reaches the right people; the
    // refold after publishing recomputes it from the log and must agree.
    st.members = st.members.filter((m) => m !== member)
    this.save()

    try {
      // Written under the NEW key: the removed device cannot read even this.
      await this.publishSys(conv, 'group-member-removed', { member, epoch: nextEpoch })
    } catch (err) {
      // Nothing landed — roll the rotation back rather than stranding this
      // device on an epoch no one else will ever have a key for.
      delete st.keys[String(nextEpoch)]
      st.epoch = prevEpoch
      st.members = prevMembers
      this.keyCache.delete(`${st.groupId}/${nextEpoch}`)
      this.save()
      throw err
    }
    this.refold(conv)
    // A rekey that fails leaves that member on the old epoch, reading history
    // and parking everything newer, until someone re-sends them the current
    // key — which is exactly what "Add people" does (addMembers invites
    // everyone asked for, member or not, and a duplicate invite is a no-op on
    // the receiver). So the recovery path here is the same one a failed invite
    // uses, and one unreachable DM must not cost the others their key.
    const failed: string[] = []
    for (const m of st.members) {
      if (m === this.session.deviceId) continue
      try {
        await this.sendInvite(m, st, true)
      } catch {
        failed.push(m)
      }
    }
    // And tell the person we removed, over the DM we share with them. The
    // removal event in the group's log is under the new key on purpose, so this
    // notice is the only way their client can ever learn the group is gone
    // rather than simply silent. It carries no key material — just the id, the
    // epoch that retired their key, and the name for the DM row.
    try {
      const dm = this.session.dmFor(member)
      if (dm) {
        await this.publishGrp(`dm:${dm.pairToken}`, 'group-removed', {
          groupId: st.groupId,
          epoch: nextEpoch,
          name: st.name,
        })
      }
    } catch {
      // Best effort: without it their client keeps a group that has gone quiet,
      // which is exactly where 1.1 left them.
    }
    this.host.pushGroups()
    if (failed.length > 0) {
      throw new Error(
        `removed, but ${failed.length} rekey${failed.length === 1 ? '' : 's'} failed — use Add people to retry`,
      )
    }
  }

  /**
   * Leave a group. Deliberately does **not** rotate the key: a departing member
   * keeps a working copy of the current epoch key, so they can still decrypt
   * anything written under it afterwards if they hold on to the folder. Only a
   * removal by the owner rotates. If a member's departure needs to cut them off
   * rather than just take them off the list, the owner removes them.
   */
  async leave(conv: ConvId): Promise<void> {
    const st = this.requireMember(conv)
    await this.publishSys(conv, 'group-left', {})
    this.host.events.forget(conv)
    this.drop(st.groupId)
    this.host.pushGroups()
  }

  /** Owner only: tombstone the group. Keys stay until the janitor grace passes. */
  async remove(conv: ConvId): Promise<void> {
    const st = this.requireMember(conv)
    if (st.owner !== this.session.deviceId) throw new Error('not-owner')
    await this.publishSys(conv, 'group-deleted', {})
    st.deletedAt = this.session.io.calibratedNow()
    this.host.events.forget(conv)
    this.save()
    this.host.pushGroups()
  }

  // -------------------------------------------------------------------------

  private requireMember(conv: ConvId): GroupState {
    const st = this.live(conv)
    if (!st) throw new Error('unknown-group')
    if (!st.members.includes(this.session.deviceId)) throw new Error('not-a-member')
    return st
  }

  private async publishSys(
    conv: ConvId,
    kind: SysPayload['kind'],
    data: Record<string, unknown>,
  ): Promise<VerifiedEvent> {
    const ev = await this.host.events.publish(conv, 'sys', { t: 'sys', conv, kind, data } satisfies SysPayload)
    this.host.noteOwnEvent(conv, `${ev.id}.sys.e1`)
    return ev
  }

  /**
   * Publish one private-group notice into a DM log. `grp`, not `sys`: a 1.1
   * client's `sysLine()` has no default branch, so an unknown sys kind renders
   * as an empty row in the middle of that DM. A `.grp.e1` filename doesn't
   * parse there at all, so the file is skipped without a trace.
   */
  private async publishGrp(
    conv: ConvId,
    kind: GrpPayload['kind'],
    data: GrpPayload['data'],
  ): Promise<VerifiedEvent> {
    const ev = await this.host.events.publish(conv, 'grp', { t: 'grp', conv, kind, data } satisfies GrpPayload)
    this.host.noteOwnEvent(conv, `${ev.id}.grp.e1`)
    return ev
  }

  /**
   * Hand one device the current key over its DM log. `key1` rides along on
   * every epoch above 1 because the directory token is derived from it — a
   * member without it could not find the group at all.
   */
  private async sendInvite(peer: string, state: GroupState, rekey: boolean): Promise<void> {
    const dm = this.session.dmFor(peer)
    if (!dm) throw new Error('unknown-member')
    const key = this.keyFor(state, state.epoch)
    const key1 = this.keyFor(state, 1)
    if (!key || !key1) throw new Error('missing-group-key')
    const data: GroupInviteData = {
      groupId: state.groupId,
      name: state.name,
      owner: state.owner,
      members: [...state.members],
      epoch: state.epoch,
      key: key.toString('base64'),
      createdAt: state.createdAt,
      ...(state.epoch > 1 ? { key1: key1.toString('base64') } : {}),
    }
    await this.publishGrp(`dm:${dm.pairToken}`, rekey ? 'group-rekey' : 'group-invite', data)
  }
}

/**
 * The group was created, and some of its invites were not delivered. Carries
 * the view so a caller can still show the group it just made, and a message a
 * toast can print verbatim.
 */
export class GroupPartialError extends Error {
  constructor(
    readonly view: GroupView,
    readonly failed: string[],
  ) {
    super(`group created; ${failed.length} invite${failed.length === 1 ? '' : 's'} failed — use Add people to retry`)
    this.name = 'GroupPartialError'
  }
}

function decodeKey(b64: unknown): Buffer | null {
  if (typeof b64 !== 'string' || b64.length === 0) return null
  const buf = Buffer.from(b64, 'base64')
  return buf.length === 32 ? buf : null
}
