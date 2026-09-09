import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CalPayload, CalendarEntry } from '@shared/types'
import type { PushMessage, SettingsView } from '@shared/bridge'
import { TEAM_CONV } from '@shared/constants'
import { materializeCalendar } from '@shared/calendar'
import { generateIdentity } from '../crypto/identity'
import type { SecretStore } from '../store/secretStore'
import { createOrJoinTeam } from '../transport/bootstrap'
import { EventStore } from '../transport/events'
import { Roster } from '../transport/roster'
import { Session } from '../transport/session'
import { ShareIo } from '../transport/shareIo'
import { ChatService } from './chatService'

// The offline outbox seen from the two places it is easy to get wrong:
// a queued team write must not be reported as a failure (a "could not save"
// invites a retry, and a retried new entry carries a second entry id), and a
// backlog persisted by a previous run must be replayed on the next launch —
// the poller's degraded→reachable edge never fires when the share is healthy
// at startup.

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

const settings = (): SettingsView => ({
  theme: 'system',
  notifyChannels: 'none',
  notifyPreviews: false,
  autoplayGifs: 'never',
  autoAcceptBeams: false,
  quietHours: { enabled: false, from: '22:00', to: '07:00' },
  fontSize: 'M',
})

/** One client against `root`, reusing `store` so a "restart" keeps its secrets. */
async function makeSession(root: string, store: FakeStore, name: string): Promise<Session> {
  const identity = generateIdentity().identity
  const io = new ShareIo(root)
  const result = await createOrJoinTeam(io, 'correct horse battery staple', 'Test Team')
  if ('error' in result) throw new Error(result.error)
  const { proto, teamSalt, tmk } = result.join
  const seed = new Session(io, store, identity, proto, teamSalt, tmk, tmk, new Roster(io, store, tmk, proto.epoch), name)
  const roster = new Roster(io, store, seed.keys.kMeta, proto.epoch)
  roster.loadPins()
  const session = new Session(io, store, identity, proto, teamSalt, tmk, tmk, roster, name)
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
  await roster.refresh()
  return session
}

function entry(id: string, title: string): CalendarEntry {
  return { id, title, tag: 'Release', color: 1, start: '2026-03-14', end: '2026-03-14', annual: false, notes: '' }
}

function put(e: CalendarEntry): CalPayload {
  return { t: 'cal', conv: TEAM_CONV.calendar, op: 'put', entry: e }
}

/** Make every share write fail, as an unmounted folder does. */
function breakPublish(chat: ChatService): void {
  ;(chat as unknown as { events: EventStore }).events.publish = (() =>
    Promise.reject(new Error('ENOENT: share gone'))) as never
}

async function calendarOnShare(root: string): Promise<CalendarEntry[]> {
  const session = await makeSession(root, new FakeStore(), 'Reader')
  const events = new EventStore(session)
  await events.catchUp(TEAM_CONV.calendar)
  return materializeCalendar(events.getEvents(TEAM_CONV.calendar))
}

describe('team writes with an unreachable share', () => {
  it('resolves as queued instead of rejecting, so one entry stays one entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sem-outbox-queued-'))
    const store = new FakeStore()
    const session = await makeSession(root, store, 'Alice')
    const chat = new ChatService(session, () => null, settings)
    const pushes: PushMessage[] = []
    chat.setPush((m) => pushes.push(m))
    breakPublish(chat)

    await expect(chat.publishTeam(TEAM_CONV.calendar, 'cal', put(entry('a'.repeat(16), 'Release 1.1')))).resolves.toEqual({
      queued: true,
    })
    expect(store.readSecretJson<unknown[]>('outbox')).toHaveLength(1)
    expect(pushes.filter((p) => p.kind === 'outbox')).toHaveLength(1)
  })

  it('still resolves as published when the share is reachable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sem-outbox-live-'))
    const session = await makeSession(root, new FakeStore(), 'Alice')
    const chat = new ChatService(session, () => null, settings)
    await expect(chat.publishTeam(TEAM_CONV.calendar, 'cal', put(entry('b'.repeat(16), 'Offsite')))).resolves.toEqual({
      queued: false,
    })
    expect(await calendarOnShare(root)).toHaveLength(1)
  })
})

describe('outbox replay across a restart', () => {
  it('publishes a backlog left by a previous run even when the share never degrades', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sem-outbox-restart-'))
    const store = new FakeStore() // the local secret store survives the restart

    // Run 1: the share is gone, so the entry only reaches the outbox.
    const first = new ChatService(await makeSession(root, store, 'Alice'), () => null, settings)
    breakPublish(first)
    await first.publishTeam(TEAM_CONV.calendar, 'cal', put(entry('c'.repeat(16), 'Sprint review')))
    expect(store.readSecretJson<unknown[]>('outbox')).toHaveLength(1)

    // Run 2: relaunch onto a healthy share — the poller never degrades here,
    // so start() is the only thing that can drain the backlog.
    const second = new ChatService(await makeSession(root, store, 'Alice'), () => null, settings)
    const pushes: PushMessage[] = []
    second.setPush((m) => pushes.push(m))
    await second.start()
    // start() kicks the flush off without awaiting it (a stalled mount must
    // not hold up launch), so wait for the queue to drain.
    for (let i = 0; i < 200 && (store.readSecretJson<unknown[]>('outbox') ?? []).length > 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    await second.stop()

    const cal = await calendarOnShare(root)
    expect(cal.map((e) => e.title)).toEqual(['Sprint review'])
    expect(store.readSecretJson<unknown[]>('outbox')).toHaveLength(0)
    // The UI hears about the restored backlog and about it draining.
    expect(pushes.filter((p) => p.kind === 'outbox').map((p) => (p as { queued: number }).queued)).toEqual([1, 0])
  })
})
