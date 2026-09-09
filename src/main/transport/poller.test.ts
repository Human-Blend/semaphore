import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PresenceView } from '@shared/types'
import { generateIdentity, type DeviceIdentity } from '../crypto/identity'
import type { SecretStore } from '../store/secretStore'
import type { BeaconObservation, BeaconReader } from './beacon'
import { createOrJoinTeam } from './bootstrap'
import { EventStore } from './events'
import { Poller } from './poller'
import { Roster } from './roster'
import { Session } from './session'
import { ShareIo } from './shareIo'

// The first poll, seen from the renderer. processObservation announces every
// device it meets, and the handler in chatService turns around and pushes the
// whole presence list — so a list derived halfway through the first listing
// must not claim the teammates not reached yet are gone.

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

/** One team folder, one session for us, and a roster holding everyone named. */
async function team(names: string[]): Promise<{ session: Session; ids: Map<string, DeviceIdentity> }> {
  const io = new ShareIo(mkdtempSync(join(tmpdir(), 'sem-poller-')))
  const res = await createOrJoinTeam(io, 'correct horse battery staple', 'Test Team')
  if ('error' in res) throw new Error(res.error)
  const { proto, teamSalt, tmk } = res.join
  const mine = generateIdentity().identity
  const seed = new Session(
    io,
    new FakeStore(),
    mine,
    proto,
    teamSalt,
    tmk,
    tmk,
    new Roster(io, new FakeStore(), tmk, proto.epoch),
    'Me',
  )
  const kMeta = seed.keys.kMeta

  const ids = new Map<string, DeviceIdentity>()
  for (const name of ['Me', ...names]) {
    const identity = name === 'Me' ? mine : generateIdentity().identity
    ids.set(name, identity)
    const roster = new Roster(io, new FakeStore(), kMeta, proto.epoch)
    await roster.publishSelf(identity, {
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
  }

  const roster = new Roster(io, new FakeStore(), kMeta, proto.epoch)
  roster.loadPins()
  await roster.refresh()
  return { session: new Session(io, new FakeStore(), mine, proto, teamSalt, tmk, tmk, roster, 'Me'), ids }
}

function beaconOf(identity: DeviceIdentity, name: string): BeaconObservation {
  const now = Date.now()
  return {
    deviceId8: identity.deviceId.slice(0, 8),
    content: {
      device: identity.deviceId,
      name,
      seq: '00000001',
      hlc: now,
      presence: { state: 'online', status: '', idleSec: 0 },
      heads: {},
      cursors: {},
    },
    verified: true,
    dmSections: new Map(),
    observedAtMono: now,
  }
}

/** Hand the poller a canned listing instead of the share's beacon dir. */
function stubListing(poller: Poller, observations: BeaconObservation[]): void {
  ;(poller as unknown as { reader: Pick<BeaconReader, 'poll'> }).reader = {
    poll: () => Promise.resolve(observations),
  }
}

describe('presence during the very first poll', () => {
  it('never flags a teammate whose beacon is in the same listing as departed', async () => {
    const { session, ids } = await team(['Ana', 'Ben', 'Cat', 'Ghost'])
    const poller = new Poller(session, new EventStore(session))
    const live = ['Ana', 'Ben', 'Cat']
    stubListing(
      poller,
      live.map((n) => beaconOf(ids.get(n)!, n)),
    )

    // Exactly how chatService is wired: a new device means re-derive and push.
    const pushes: PresenceView[][] = []
    poller.listeners = {
      onNewDevice: () => pushes.push(poller.presenceViews()),
      onPresence: (views) => pushes.push(views),
    }
    await poller.tick()

    const liveIds = new Set(live.map((n) => ids.get(n)!.deviceId))
    expect(pushes.length).toBe(live.length + 1) // one per device, then the tick's own
    for (const views of pushes) {
      expect(views.filter((v) => v.departed && liveIds.has(v.deviceId))).toEqual([])
    }
  })

  it('still hides a registration with no beacon at all once the listing is in', async () => {
    const { session, ids } = await team(['Ana', 'Ghost'])
    const poller = new Poller(session, new EventStore(session))
    stubListing(poller, [beaconOf(ids.get('Ana')!, 'Ana')])

    const before = poller.presenceViews()
    expect(before.every((v) => !v.departed)).toBe(true) // no listing yet: absence means nothing

    await poller.tick()
    const after = new Map(poller.presenceViews().map((v) => [v.deviceId, v]))
    expect(after.get(ids.get('Ana')!.deviceId)?.departed).toBe(false)
    expect(after.get(ids.get('Ghost')!.deviceId)?.departed).toBe(true)
  })
})
