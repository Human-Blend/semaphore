import { randomBytes } from 'node:crypto'
import { DIR, DST, FILE_EXT, KID } from '@shared/constants'
import type { ChannelMeta, ConvId, ProtocolFile, SignedRecord, TeamConfig } from '@shared/types'
import { isChanConv, isTeamConv } from '@shared/ids'
import { newHlcState, type HlcState } from '@shared/hlc'
import { buildAad, decryptRecord, encryptRecord } from '../crypto/envelope'
import {
  convToken,
  deriveConvKey,
  deriveDmKey,
  deriveTeamKeys,
  dmPairToken,
  type TeamKeys,
} from '../crypto/keys'
import { dmSharedSecret, signRecord, verifyRecord, type DeviceIdentity } from '../crypto/identity'
import type { SecretStore } from '../store/secretStore'
import { Roster } from './roster'
import type { ShareIo } from './shareIo'

// A Session is the fully-unlocked state: share mounted, passphrase verified,
// identity loaded, team keys derived. It owns conversation key material and
// the channel/DM registries; transports (events, beacon, blobs) hang off it.

export interface ChannelState {
  channelId: string
  token: string
  meta: ChannelMeta
  key: Buffer
}

export interface DmState {
  peerDeviceId: string
  pairToken: string
  key: Buffer
}

/**
 * A team conversation ('team:calendar', 'team:prs'): an app-defined event log
 * under `team/<token>/events`. There is no `channel.json.e1` metadata file —
 * the whole ConvId is the key id and the existence of the log is implied.
 */
export interface TeamState {
  conv: `team:${string}`
  token: string
  key: Buffer
}

export class Session {
  readonly hlc: HlcState = newHlcState()
  readonly channels = new Map<string, ChannelState>() // channelId -> state
  readonly channelsByToken = new Map<string, ChannelState>()
  readonly dms = new Map<string, DmState>() // peerDeviceId -> state
  readonly dmsByToken = new Map<string, DmState>()
  /** Derived lazily per team conv id; HKDF is cheap but convInfo() is hot. */
  private teams = new Map<string, TeamState>()
  readonly keys: TeamKeys
  /** Per-conversation monotonic sequence for our own messages (gap detection). */
  private senderSeqs: Record<string, number>

  constructor(
    readonly io: ShareIo,
    readonly store: SecretStore,
    readonly identity: DeviceIdentity,
    readonly proto: ProtocolFile,
    readonly teamSalt: Buffer,
    readonly tmk: Buffer,
    readonly tmk1: Buffer,
    readonly roster: Roster,
    public displayName: string,
  ) {
    this.keys = deriveTeamKeys(proto.epoch, tmk, tmk1, teamSalt)
    this.senderSeqs = store.readSecretJson<Record<string, number>>('sender-seqs') ?? {}
  }

  get deviceId(): string {
    return this.identity.deviceId
  }

  get deviceId8(): string {
    return this.identity.deviceId.slice(0, 8)
  }

  nextSenderSeq(conv: ConvId): number {
    const n = (this.senderSeqs[conv] ?? 0) + 1
    this.senderSeqs[conv] = n
    this.store.writeSecretJson('sender-seqs', this.senderSeqs)
    return n
  }

  // -------------------------------------------------------------------------
  // Channels

  async loadChannels(): Promise<void> {
    const tokens = await this.io.listDirs(DIR.channels)
    for (const token of tokens) {
      if (this.channelsByToken.has(token)) continue
      await this.loadChannel(token)
    }
  }

  private async loadChannel(token: string): Promise<ChannelState | null> {
    const rel = `${DIR.channels}/${token}/channel.json${FILE_EXT.record}`
    const buf = await this.io.readMaybe(rel)
    if (!buf) return null
    try {
      const aad = buildAad('meta', rel, token)
      const plain = decryptRecord(buf, this.keys.kMeta, aad)
      const signed = JSON.parse(plain.toString('utf8')) as SignedRecord<ChannelMeta>
      const author = this.roster.get(signed.by)
      if (author && !verifyRecord(signed, DST.record, author.edPubKey)) return null
      const meta = signed.p
      if (convToken(this.keys.kMeta, meta.channelId) !== token) return null // dir/meta mismatch
      const state: ChannelState = {
        channelId: meta.channelId,
        token,
        meta,
        key: deriveConvKey(this.tmk, this.teamSalt, this.proto.epoch, meta.channelId),
      }
      this.channels.set(meta.channelId, state)
      this.channelsByToken.set(token, state)
      return state
    } catch {
      return null
    }
  }

  async createChannel(name: string, topic = ''): Promise<ChannelState> {
    const channelId = randomBytes(4).toString('hex')
    const token = convToken(this.keys.kMeta, channelId)
    const meta: ChannelMeta = {
      type: 'channel',
      channelId,
      name,
      topic,
      creator: this.deviceId,
      created: this.io.calibratedNow(),
    }
    const signed = signRecord(this.identity, DST.record, meta)
    const rel = `${DIR.channels}/${token}/channel.json${FILE_EXT.record}`
    const aad = buildAad('meta', rel, token)
    await this.io.publish(rel, encryptRecord(this.keys.kMeta, KID.meta(this.proto.epoch), Buffer.from(JSON.stringify(signed)), aad))
    await this.io.ensureDir(`${DIR.channels}/${token}/events`)
    const state: ChannelState = {
      channelId,
      token,
      meta,
      key: deriveConvKey(this.tmk, this.teamSalt, this.proto.epoch, channelId),
    }
    this.channels.set(channelId, state)
    this.channelsByToken.set(token, state)
    return state
  }

  // -------------------------------------------------------------------------
  // DMs — derived lazily per known peer; both sides compute identical tokens.

  dmFor(peerDeviceId: string): DmState | null {
    const existing = this.dms.get(peerDeviceId)
    if (existing) return existing
    const peer = this.roster.get(peerDeviceId)
    if (!peer) return null
    const shared = dmSharedSecret(this.identity, peer.pin.xPub)
    const key = deriveDmKey(shared, this.deviceId, peerDeviceId)
    const state: DmState = { peerDeviceId, pairToken: dmPairToken(key), key }
    this.dms.set(peerDeviceId, state)
    this.dmsByToken.set(state.pairToken, state)
    return state
  }

  /** Materialize DM states for every known roster device (cheap DH each). */
  refreshDms(): void {
    for (const e of this.roster.all()) {
      if (e.record.deviceId !== this.deviceId) this.dmFor(e.record.deviceId)
    }
  }

  // -------------------------------------------------------------------------
  // Conversation helpers shared by events/beacon

  /**
   * Key material and directory for a team conv. No metadata file and no
   * discovery step: the ConvId itself ('team:calendar') is the key id, so both
   * sides derive the same token and key from the team keys alone.
   */
  teamFor(conv: `team:${string}`): TeamState {
    const existing = this.teams.get(conv)
    if (existing) return existing
    const state: TeamState = {
      conv,
      token: convToken(this.keys.kMeta, conv),
      key: deriveConvKey(this.tmk, this.teamSalt, this.proto.epoch, conv),
    }
    this.teams.set(conv, state)
    return state
  }

  convInfo(conv: ConvId): { key: Buffer; eventsDir: string; kid: string; scope: string } | null {
    if (isChanConv(conv)) {
      const ch = this.channels.get(conv.slice(5))
      if (!ch) return null
      return {
        key: ch.key,
        eventsDir: `${DIR.channels}/${ch.token}/events`,
        kid: KID.conv(this.proto.epoch, ch.token),
        scope: 'conv',
      }
    }
    if (isTeamConv(conv)) {
      const t = this.teamFor(conv)
      return {
        key: t.key,
        eventsDir: `${DIR.team}/${t.token}/events`,
        kid: KID.conv(this.proto.epoch, t.token),
        scope: 'team',
      }
    }
    const dm = this.dmsByToken.get(conv.slice(3))
    if (!dm) return null
    return {
      key: dm.key,
      eventsDir: `${DIR.dm}/${dm.pairToken}/events`,
      kid: KID.dm(dm.pairToken),
      scope: 'dm',
    }
  }

  convIdForChannel(channelId: string): ConvId {
    return `chan:${channelId}`
  }

  convIdForPeer(peerDeviceId: string): ConvId | null {
    const dm = this.dmFor(peerDeviceId)
    return dm ? `dm:${dm.pairToken}` : null
  }

  // -------------------------------------------------------------------------
  // Team config

  async readTeamConfig(): Promise<TeamConfig | null> {
    const rel = `${DIR.config}/team.json${FILE_EXT.record}`
    const buf = await this.io.readMaybe(rel)
    if (!buf) return null
    try {
      const aad = buildAad('meta', rel, 'team-config')
      const signed = JSON.parse(decryptRecord(buf, this.keys.kMeta, aad).toString('utf8')) as SignedRecord<TeamConfig>
      return signed.p
    } catch {
      return null
    }
  }

  async writeTeamConfig(config: TeamConfig): Promise<void> {
    const rel = `${DIR.config}/team.json${FILE_EXT.record}`
    const aad = buildAad('meta', rel, 'team-config')
    const signed = signRecord(this.identity, DST.record, config)
    await this.io.publish(rel, encryptRecord(this.keys.kMeta, KID.meta(this.proto.epoch), Buffer.from(JSON.stringify(signed)), aad))
  }
}
