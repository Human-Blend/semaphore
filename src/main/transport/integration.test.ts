import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConvId, MsgPayload } from '@shared/types'
import { materialize } from '@shared/merge'
import { generateIdentity, type DeviceIdentity } from '../crypto/identity'
import type { SecretStore } from '../store/secretStore'
import { BeaconWriter, BeaconReader } from './beacon'
import { createOrJoinTeam } from './bootstrap'
import { EventStore } from './events'
import { Roster } from './roster'
import { Session } from './session'
import { ShareIo } from './shareIo'

// Two complete clients against one local folder standing in for the SMB share:
// bootstrap race, roster TOFU, channel creation/discovery, messaging with
// signature verification, DM privacy, beacon heads-driven ingestion, and the
// impersonation flag. This is the protocol's end-to-end truth test.

class FakeStore implements SecretStore {
  readonly unlocked = true
  private m = new Map<string, Buffer>()
  writeSecret(name: string, data: Buffer): void {
    this.m.set(name, Buffer.from(data))
  }
  readSecret(name: string): Buffer | null {
    return this.m.get(name) ?? null
  }
  writeSecretJson(name: string, value: unknown): void {
    this.writeSecret(name, Buffer.from(JSON.stringify(value)))
  }
  readSecretJson<T>(name: string): T | null {
    const b = this.readSecret(name)
    return b ? (JSON.parse(b.toString()) as T) : null
  }
  deleteSecret(name: string): void {
    this.m.delete(name)
  }
}

interface Client {
  identity: DeviceIdentity
  io: ShareIo
  store: FakeStore
  session: Session
  events: EventStore
  writer: BeaconWriter
  reader: BeaconReader
}

async function makeClient(root: string, passphrase: string, name: string): Promise<Client> {
  const identity = generateIdentity().identity
  const io = new ShareIo(root)
  const store = new FakeStore()
  const result = await createOrJoinTeam(io, passphrase, 'Test Team')
  if ('error' in result) throw new Error(result.error)
  const { proto, teamSalt, tmk } = result.join
  const roster = new Roster(io, store, /* kMeta derived inside session, but roster needs it too */ tmk, proto.epoch)
  // NOTE: roster's kMeta must equal the session's kMeta — construct session first
  const session = new Session(io, store, identity, proto, teamSalt, tmk, tmk, roster, name)
  // Rebind roster with the real kMeta (test convenience: recreate)
  const realRoster = new Roster(io, store, session.keys.kMeta, proto.epoch)
  realRoster.loadPins()
  const session2 = new Session(io, store, identity, proto, teamSalt, tmk, tmk, realRoster, name)
  await realRoster.publishSelf(identity, {
    deviceId: identity.deviceId,
    edPub: identity.edPub,
    xPub: identity.xPub,
    displayName: name,
    hostname: `${name}-host`,
    osUser: name.toLowerCase(),
    platform: 'darwin',
    machineIdHash: null,
    firstSeen: Date.now(),
    recSeq: 1,
  })
  const events = new EventStore(session2)
  const writer = new BeaconWriter(session2)
  const reader = new BeaconReader(session2)
  return { identity, io, store, session: session2, events, writer, reader }
}

describe('two-client integration over a shared folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'semaphore-share-'))
  let alice: Client
  let bob: Client

  beforeAll(async () => {
    alice = await makeClient(root, 'correct horse battery staple', 'Alice')
    bob = await makeClient(root, 'correct horse battery staple', 'Bob')
    await alice.session.roster.refresh()
    await bob.session.roster.refresh()
    alice.session.refreshDms()
    bob.session.refreshDms()
  }, 60_000)

  it('wrong passphrase is rejected', async () => {
    const io = new ShareIo(root)
    const res = await createOrJoinTeam(io, 'wrong password entirely', 'x')
    expect(res).toEqual({ error: 'wrong-passphrase' })
  }, 60_000)

  it('both clients see each other in the roster with verified records', () => {
    expect(alice.session.roster.get(bob.identity.deviceId)?.record.displayName).toBe('Bob')
    expect(bob.session.roster.get(alice.identity.deviceId)?.record.displayName).toBe('Alice')
  })

  it('channel created by Alice is discovered and readable by Bob', async () => {
    const ch = await alice.session.createChannel('general', 'team chat')
    const conv: ConvId = `chan:${ch.channelId}`
    const msg: MsgPayload = {
      t: 'msg',
      conv,
      author: { device: alice.identity.deviceId, name: 'Alice' },
      senderSeq: alice.session.nextSenderSeq(conv),
      sentWall: Date.now(),
      body: { kind: 'text', text: 'hello team' },
    }
    await alice.events.publish(conv, 'msg', msg)

    await bob.session.loadChannels()
    expect(bob.session.channels.get(ch.channelId)?.meta.name).toBe('general')
    await bob.events.catchUp(conv)
    const events = bob.events.getEvents(conv)
    expect(events).toHaveLength(1)
    expect(events[0].verified).toBe(true)
    const log = materialize(events)
    expect(log.messages[0].body.text).toBe('hello team')
    expect(log.messages[0].authorName).toBe('Alice')
  })

  it('edits and reactions merge correctly across clients', async () => {
    const ch = await alice.session.createChannel('dev')
    const conv: ConvId = `chan:${ch.channelId}`
    const sent = await alice.events.publish(conv, 'msg', {
      t: 'msg',
      conv,
      author: { device: alice.identity.deviceId, name: 'Alice' },
      senderSeq: alice.session.nextSenderSeq(conv),
      sentWall: Date.now(),
      body: { kind: 'text', text: 'typo hre' },
    } satisfies MsgPayload)
    await alice.events.publish(conv, 'edt', { t: 'edt', conv, target: sent.id, body: { kind: 'text', text: 'typo here — fixed' } })
    await bob.session.loadChannels()
    await bob.events.catchUp(conv)
    await bob.events.publish(conv, 'rct', { t: 'rct', conv, target: sent.id, emoji: '👍', op: 'add' })
    await alice.events.catchUp(conv)

    for (const c of [alice, bob]) {
      const log = materialize(c.events.getEvents(conv))
      expect(log.messages).toHaveLength(1)
      expect(log.messages[0].body.text).toBe('typo here — fixed')
      expect(log.messages[0].edited).toBe(true)
      expect(log.messages[0].reactions).toEqual([{ emoji: '👍', devices: [bob.identity.deviceId] }])
    }
  })

  it("a non-author cannot edit someone else's message", async () => {
    const ch = await alice.session.createChannel('sec')
    const conv: ConvId = `chan:${ch.channelId}`
    const sent = await alice.events.publish(conv, 'msg', {
      t: 'msg',
      conv,
      author: { device: alice.identity.deviceId, name: 'Alice' },
      senderSeq: alice.session.nextSenderSeq(conv),
      sentWall: Date.now(),
      body: { kind: 'text', text: 'original' },
    } satisfies MsgPayload)
    await bob.session.loadChannels()
    await bob.events.catchUp(conv)
    await bob.events.publish(conv, 'edt', { t: 'edt', conv, target: sent.id, body: { kind: 'text', text: 'hijacked' } })
    await alice.events.catchUp(conv)
    const log = materialize(alice.events.getEvents(conv))
    expect(log.messages[0].body.text).toBe('original')
    expect(log.messages[0].edited).toBe(false)
  })

  it('DMs are end-to-end: both participants read, dirs are opaque tokens', async () => {
    const convA = alice.session.convIdForPeer(bob.identity.deviceId)!
    const convB = bob.session.convIdForPeer(alice.identity.deviceId)!
    expect(convA).toBe(convB) // identical pair token from both sides

    await alice.events.publish(convA, 'msg', {
      t: 'msg',
      conv: convA,
      author: { device: alice.identity.deviceId, name: 'Alice' },
      senderSeq: alice.session.nextSenderSeq(convA),
      sentWall: Date.now(),
      body: { kind: 'text', text: 'secret plan' },
    } satisfies MsgPayload)
    await bob.events.catchUp(convB)
    const log = materialize(bob.events.getEvents(convB))
    expect(log.messages[0].body.text).toBe('secret plan')

    // The pair token reveals nothing about the participants
    const token = convA.slice(3)
    expect(token).not.toContain(alice.identity.deviceId.slice(0, 8))
    expect(token).not.toContain(bob.identity.deviceId.slice(0, 8))
  })

  it('beacon round-trip: heads drive ingestion without directory scans', async () => {
    const ch = await alice.session.createChannel('beacon-test')
    const conv: ConvId = `chan:${ch.channelId}`
    const sent = await alice.events.publish(conv, 'msg', {
      t: 'msg',
      conv,
      author: { device: alice.identity.deviceId, name: 'Alice' },
      senderSeq: alice.session.nextSenderSeq(conv),
      sentWall: Date.now(),
      body: { kind: 'text', text: 'via beacon' },
    } satisfies MsgPayload)
    alice.writer.noteOwnEvent(conv, `${sent.id}.msg.e1`)
    await alice.writer.bump('event')

    const observations = await bob.reader.poll()
    const fromAlice = observations.find((o) => o.content.device === alice.identity.deviceId)
    expect(fromAlice).toBeDefined()
    expect(fromAlice!.verified).toBe(true)
    const heads = fromAlice!.content.heads[conv]
    expect(heads).toContain(`${sent.id}.msg.e1`)

    await bob.session.loadChannels()
    await bob.events.ingestHeads(conv, heads)
    expect(bob.events.has(conv, sent.id)).toBe(true)
  })

  it('flags a new device claiming an existing display name', async () => {
    const mallory = await makeClient(root, 'correct horse battery staple', 'Alice') // same name!
    await bob.session.roster.refresh()
    const pin = bob.session.roster.getPin(mallory.identity.deviceId)
    expect(pin?.trust).toBe('flagged')
    // The real Alice keeps her clean pin
    expect(bob.session.roster.getPin(alice.identity.deviceId)?.trust).toBe('pinned')
  }, 60_000)
})
