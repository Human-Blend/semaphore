import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Attachment, MsgPayload } from '@shared/types'
import type { SendDraft, SettingsView } from '@shared/bridge'
import { DIAGRAM, EVENT } from '@shared/constants'
import { generateIdentity } from '../crypto/identity'
import type { SecretStore } from '../store/secretStore'
import { createOrJoinTeam } from '../transport/bootstrap'
import { EventStore } from '../transport/events'
import { Roster } from '../transport/roster'
import { Session } from '../transport/session'
import { ShareIo } from '../transport/shareIo'
import { ChatService } from './chatService'

// The diagram send path (1.2), against a real session writing to a real folder.
//
// Three things have to hold and only one of them is visible in the UI:
//   - a small scene rides *inside* the message event, so reading it later costs
//     no share I/O and it lives as long as messages do;
//   - a large one becomes a `.excalidraw` attachment instead, and the event
//     carries only the metadata;
//   - either way `body.text` is the line a 1.1.x client will print, because
//     that client renders nothing else.

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

async function makeSession(root: string, name: string): Promise<Session> {
  const store = new FakeStore()
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

async function chatOn(dir: string): Promise<{ chat: ChatService; conv: `chan:${string}` }> {
  const root = mkdtempSync(join(tmpdir(), dir))
  const session = await makeSession(root, 'Alice')
  const chat = new ChatService(session, () => null, settings)
  const ch = await session.createChannel('general', '')
  return { chat, conv: `chan:${ch.channelId}` }
}

/** Read the message back the way a peer would: off the share, decrypted. */
function sentBody(chat: ChatService, conv: `chan:${string}`): MsgPayload {
  const events = (chat as unknown as { events: EventStore }).events.getEvents(conv)
  const msg = events.find((e) => e.type === 'msg')
  if (!msg) throw new Error('no message was published')
  return msg.payload as MsgPayload
}

const uploaded: Attachment = {
  blobId: 'a'.repeat(32),
  key: Buffer.alloc(32).toString('base64'),
  name: 'Sprint plan.excalidraw',
  size: 900_000,
  mime: DIAGRAM.mime,
  sha256: 'b'.repeat(64),
}

function draft(over: Partial<SendDraft> = {}): SendDraft {
  return {
    text: 'Sprint plan',
    kind: 'diagram',
    diagram: { fmt: 'excalidraw', w: 900, h: 540, elements: 14, thumb: 'data:image/webp;base64,AAAA', data: 'SGVsbG8=' },
    ...over,
  }
}

describe('chatService.send — inline diagrams', () => {
  it('keeps the scene in the message and writes the pre-1.2 fallback line', async () => {
    const { chat, conv } = await chatOn('sem-diagram-inline-')
    await chat.send(conv, draft())

    const body = sentBody(chat, conv).body
    expect(body.kind).toBe('diagram')
    expect(body.diagram?.data).toBe('SGVsbG8=')
    expect(body.diagram?.elements).toBe(14)
    expect(body.diagram?.thumb).toMatch(/^data:image\/webp/)
    // What a 1.1.x client prints, since it renders `text` and nothing else.
    expect(body.text).toBe('📐 Diagram: Sprint plan — update Chat to view it')
    expect(sentBody(chat, conv).attachments).toBeUndefined()
  })

  it('needs no attachment uploader at all — nothing leaves the event', async () => {
    const { chat, conv } = await chatOn('sem-diagram-noupload-')
    chat.attachmentUploader = null
    await expect(chat.send(conv, draft())).resolves.toHaveProperty('id')
  })

  it('the whole event still fits the 256 KB ceiling', async () => {
    const { chat, conv } = await chatOn('sem-diagram-ceiling-')
    await chat.send(conv, draft({ diagram: { ...draft().diagram!, data: 'A'.repeat(DIAGRAM.maxInlineBytes) } }))
    const body = sentBody(chat, conv).body
    expect(JSON.stringify(body).length).toBeLessThan(EVENT.maxFileBytes)
  })
})

describe('chatService.send — blob-backed diagrams', () => {
  it('uploads the staged scene and leaves the event carrying only metadata', async () => {
    const { chat, conv } = await chatOn('sem-diagram-blob-')
    const seen: string[] = []
    chat.attachmentUploader = async (items) => {
      seen.push(...items.map((i) => i.path))
      return [uploaded]
    }

    await chat.send(
      conv,
      draft({
        diagram: { fmt: 'excalidraw', w: 4000, h: 3000, elements: 900, thumb: 'data:image/webp;base64,AAAA' },
        attachments: [{ path: '/tmp/staging/deadbeef/Sprint plan.excalidraw' }],
      }),
    )

    expect(seen).toEqual(['/tmp/staging/deadbeef/Sprint plan.excalidraw'])
    const payload = sentBody(chat, conv)
    expect(payload.body.diagram?.data).toBeUndefined()
    expect(payload.body.diagram?.elements).toBe(900)
    expect(payload.attachments?.[0]?.blobId).toBe(uploaded.blobId)
    expect(payload.body.text).toBe('📐 Diagram: Sprint plan — update Chat to view it')
  })
})

describe('chatService.send — the guards', () => {
  it('refuses a scene above the inline ceiling rather than letting publish fail', async () => {
    const { chat, conv } = await chatOn('sem-diagram-toobig-')
    await expect(
      chat.send(conv, draft({ diagram: { ...draft().diagram!, data: 'A'.repeat(DIAGRAM.maxInlineBytes + 1) } })),
    ).rejects.toThrow(/diagram-too-large/)
  })

  it('refuses a scene whose thumb would burst the event ceiling', async () => {
    const { chat, conv } = await chatOn('sem-diagram-thumbfat-')
    await expect(
      chat.send(
        conv,
        draft({
          diagram: {
            ...draft().diagram!,
            data: 'A'.repeat(DIAGRAM.maxInlineBytes),
            thumb: `data:image/webp;base64,${'A'.repeat(EVENT.maxThumbBytes * 8)}`,
          },
        }),
      ),
    ).rejects.toThrow(/diagram-too-large/)
  })

  it("refuses a 'diagram' message with no diagram in it", async () => {
    const { chat, conv } = await chatOn('sem-diagram-missing-')
    await expect(chat.send(conv, { text: 'Sprint plan', kind: 'diagram' })).rejects.toThrow(/diagram-missing/)
  })

  it('leaves every other message kind untouched', async () => {
    const { chat, conv } = await chatOn('sem-diagram-plain-')
    await chat.send(conv, { text: 'just words', kind: 'text' })
    expect(sentBody(chat, conv).body).toMatchObject({ kind: 'text', text: 'just words' })
    expect(sentBody(chat, conv).body.diagram).toBeUndefined()
  })
})
