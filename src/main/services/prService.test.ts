import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// PrService reaches Electron for exactly two things: OS notifications and
// net.fetch. Both are replaced here — net.fetch never runs at all, because the
// service takes an injected FetchLike — so the diff/notify/seen logic is
// testable in plain node.
const notifications: { title: string; body: string; clicks: (() => void)[]; shown: boolean }[] = []
vi.mock('electron', () => ({
  net: { fetch: () => Promise.reject(new Error('net.fetch must not be used in tests')) },
  Notification: class {
    static isSupported(): boolean {
      return true
    }
    private rec: (typeof notifications)[number]
    constructor(opts: { title: string; body: string }) {
      this.rec = { title: opts.title, body: opts.body, clicks: [], shown: false }
    }
    on(_evt: string, cb: () => void): this {
      this.rec.clicks.push(cb)
      return this
    }
    show(): void {
      this.rec.shown = true
      notifications.push(this.rec)
    }
  },
}))

import type { BrowserWindow } from 'electron'
import type { PushMessage } from '@shared/bridge'
import type { ConvId, EventPayload, PrsConfig, PrsPayload, VerifiedEvent } from '@shared/types'
import { POLL, TEAM_CONV } from '@shared/constants'
import type { SecretStore } from '../store/secretStore'
import type { ChatService } from './chatService'
import type { AdoResponse, FetchLike } from './ado'
import { PrService } from './prService'

// ---------------------------------------------------------------------------
// Doubles

class FakeStore implements SecretStore {
  readonly unlocked = true
  readonly data = new Map<string, string>()
  writeSecret(name: string, data: Buffer): void {
    this.data.set(name, data.toString('base64'))
  }
  readSecret(name: string): Buffer | null {
    const v = this.data.get(name)
    return v === undefined ? null : Buffer.from(v, 'base64')
  }
  writeSecretJson(name: string, value: unknown): void {
    this.data.set(name, JSON.stringify(value))
  }
  readSecretJson<T>(name: string): T | null {
    const v = this.data.get(name)
    return v === undefined ? null : (JSON.parse(v) as T)
  }
  deleteSecret(name: string): void {
    this.data.delete(name)
  }
}

/** Just enough ChatService for the team log: a listener list and an append. */
class FakeChat {
  private listeners: ((conv: ConvId, ev: VerifiedEvent) => void)[] = []
  private log: VerifiedEvent[] = []
  private seq = 0
  readonly published: { conv: string; type: string; payload: EventPayload }[] = []

  readonly events = {
    onEvent: (cb: (conv: ConvId, ev: VerifiedEvent) => void): void => {
      this.listeners.push(cb)
    },
  }

  getEvents(conv: ConvId): VerifiedEvent[] {
    return conv === TEAM_CONV.prs ? this.log.slice() : []
  }

  async publishTeam(conv: ConvId, type: 'cal' | 'prs', payload: EventPayload): Promise<VerifiedEvent> {
    this.published.push({ conv, type, payload })
    return this.append(payload as PrsPayload, 'me-device')
  }

  /** Append a config snapshot as if it arrived from the share. */
  append(payload: PrsPayload, author: string, verified = true): VerifiedEvent {
    const ev: VerifiedEvent = {
      id: String(1_700_000_000_000 + this.seq++).padStart(13, '0') + '-0000-aabbccdd',
      type: 'prs',
      payload,
      author,
      verified,
      receivedAt: Date.now(),
    }
    this.log.push(ev)
    for (const cb of this.listeners) cb(TEAM_CONV.prs, ev)
    return ev
  }
}

// ---------------------------------------------------------------------------
// ADO fixtures

interface RawPr {
  pullRequestId: number
  title: string
  status: string
  isDraft: boolean
  createdBy: { id: string; displayName: string }
  creationDate: string
  sourceRefName: string
  targetRefName: string
  repository: { id: string; name: string }
  reviewers: { id: string; displayName: string; vote: number; isRequired?: boolean }[]
}

function rawPr(over: Partial<RawPr> & { pullRequestId: number }): RawPr {
  return {
    title: `PR ${over.pullRequestId}`,
    status: 'active',
    isDraft: false,
    createdBy: { id: 'author-1', displayName: 'Grace' },
    creationDate: '2026-09-01T10:00:00Z',
    sourceRefName: 'refs/heads/feature/x',
    targetRefName: 'refs/heads/main',
    repository: { id: 'r1', name: 'api' },
    reviewers: [{ id: 'me-1', displayName: 'Ada', vote: 0, isRequired: true }],
    ...over,
  }
}

function jsonRes(value: unknown): AdoResponse {
  return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(value) }
}

const CONFIG: PrsConfig = {
  baseUrl: 'https://dev.azure.com/acme',
  project: 'Proj',
  repos: [{ id: 'r1', name: 'api' }],
  sharedToken: 'shared-token-value',
}

function configEvent(config: Partial<PrsConfig> = {}): PrsPayload {
  return { t: 'prs', conv: TEAM_CONV.prs, config: { ...CONFIG, ...config } }
}

/**
 * The stored shape of 'prs-token': the PAT plus the origin it was entered for.
 * The token is only ever sent to that origin.
 */
function personal(token: string, origin = 'https://dev.azure.com'): { token: string; origin: string } {
  return { token, origin }
}

// ---------------------------------------------------------------------------

interface Harness {
  svc: PrService
  chat: FakeChat
  store: FakeStore
  pushes: PushMessage[]
  urls: string[]
  /** The token each request carried, in order (`Basic base64(':'+token)` decoded). */
  tokens: string[]
  setPrs(list: RawPr[]): void
  failNext(res: AdoResponse | Error): void
  failAlways(res: AdoResponse | Error | null): void
  /** Hold the next pull-request fetches open; the returned function lets them go. */
  holdPrs(): () => void
  focused: { value: boolean }
}

function harness(): Harness {
  const chat = new FakeChat()
  const store = new FakeStore()
  const pushes: PushMessage[] = []
  const urls: string[] = []
  const tokens: string[] = []
  let prs: RawPr[] = []
  let override: AdoResponse | Error | null = null
  let always: AdoResponse | Error | null = null
  let hold: Promise<void> | null = null
  const focused = { value: false }

  const fetchImpl: FetchLike = async (url, init) => {
    urls.push(url)
    const auth = init.headers.Authorization ?? ''
    tokens.push(Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString('utf8').replace(/^:/, ''))
    if (hold && url.includes('/pullrequests')) await hold
    const o = override ?? always
    if (o) {
      override = null
      if (o instanceof Error) throw o
      return o
    }
    if (url.includes('/_apis/connectionData')) {
      return jsonRes({ authenticatedUser: { id: 'me-1', providerDisplayName: 'Ada' } })
    }
    if (url.includes('/pullrequests')) return jsonRes({ value: prs })
    if (url.includes('/_apis/projects')) return jsonRes({ value: [{ id: 'p1', name: 'Proj' }] })
    if (url.includes('/_apis/git/repositories')) {
      return jsonRes({ value: [{ id: 'r1', name: 'api', defaultBranch: 'refs/heads/main' }] })
    }
    return jsonRes({ value: [] })
  }

  const win = {
    isFocused: () => focused.value,
    show: () => {},
    focus: () => {},
  } as unknown as BrowserWindow

  const svc = new PrService(
    chat as unknown as ChatService,
    store,
    () => win,
    (m) => pushes.push(m),
    () => '1.1.0',
    fetchImpl,
  )

  return {
    svc,
    chat,
    store,
    pushes,
    urls,
    tokens,
    focused,
    setPrs: (list) => {
      prs = list
    },
    failNext: (res) => {
      override = res
    },
    failAlways: (res) => {
      always = res
    },
    holdPrs: () => {
      let release = (): void => {}
      hold = new Promise<void>((resolve) => {
        release = () => {
          hold = null
          resolve()
        }
      })
      return release
    },
  }
}

/** Run the first scheduled poll (3 s after start) to completion. */
async function firstPoll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(3_000)
}

/** Run the next steady-state poll. */
async function nextPoll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(POLL.prsMs)
}

beforeEach(() => {
  notifications.length = 0
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------

describe('PrService — configuration', () => {
  it('starts unconfigured and never touches the network', async () => {
    const h = harness()
    h.svc.start()
    await firstPoll()
    const s = h.svc.status()
    expect(s.configured).toBe(false)
    expect(s.tokenSource).toBe('none')
    expect(s.error).toBeNull()
    expect(h.urls).toEqual([])
    h.svc.stop()
  })

  it('materializes the config already in the log at start()', () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    const s = h.svc.status()
    expect(s.configured).toBe(true)
    expect(s.baseUrl).toBe('https://dev.azure.com/acme')
    expect(s.project).toBe('Proj')
    expect(s.repos).toEqual([{ id: 'r1', name: 'api' }])
    expect(s.tokenSource).toBe('shared')
    h.svc.stop()
  })

  it('ignores unverified config events', () => {
    const h = harness()
    h.chat.append(configEvent(), 'forger', false)
    h.svc.start()
    expect(h.svc.status().configured).toBe(false)
    h.svc.stop()
  })

  it('a personal token outranks the shared one', () => {
    const h = harness()
    h.store.writeSecretJson('prs-token', personal('my-own-token'))
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    expect(h.svc.status().tokenSource).toBe('personal')
    h.svc.stop()
  })

  it('a config arriving from the share polls immediately instead of waiting', async () => {
    const h = harness()
    h.svc.start()
    await firstPoll()
    expect(h.urls).toEqual([])

    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.chat.append(configEvent(), 'someone')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.svc.list().map((p) => p.id)).toEqual([1])
    h.svc.stop()
  })

  it('a config with no token source polls nothing and reports no error', async () => {
    const h = harness()
    h.chat.append(configEvent({ sharedToken: '' }), 'someone')
    h.svc.start()
    await firstPoll()
    expect(h.svc.status().tokenSource).toBe('none')
    expect(h.svc.status().error).toBeNull()
    expect(h.urls).toEqual([])
    h.svc.stop()
  })
})

describe('PrService — polling and tracking', () => {
  it('keeps only tracked PRs and projects them into PrViews', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([
      rawPr({ pullRequestId: 1 }),
      rawPr({ pullRequestId: 2, isDraft: true }),
      rawPr({ pullRequestId: 3, status: 'completed' }),
      rawPr({
        pullRequestId: 4,
        reviewers: [{ id: 'x', displayName: 'X', vote: 10, isRequired: true }],
      }),
    ])
    h.svc.start()
    await firstPoll()

    const list = h.svc.list()
    expect(list.map((p) => p.id)).toEqual([1])
    const pr = list[0]
    expect(pr.key).toBe('r1:1')
    expect(pr.sourceBranch).toBe('feature/x')
    expect(pr.targetBranch).toBe('main')
    expect(pr.webUrl).toBe('https://dev.azure.com/acme/Proj/_git/api/pullrequest/1')
    expect(pr.assignedToMe).toBe(true)
    expect(pr.myVote).toBe(0)
    expect(pr.seen).toBe(false)
    expect(h.svc.status().unseen).toBe(1)
    expect(h.svc.status().me).toEqual({ id: 'me-1', name: 'Ada' })
    h.svc.stop()
  })

  it('pushes {kind:"prs"} with the list and the status', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()

    const last = [...h.pushes].reverse().find((m) => m.kind === 'prs')
    expect(last).toBeDefined()
    if (last?.kind === 'prs') {
      expect(last.prs.map((p) => p.id)).toEqual([1])
      expect(last.status.polling).toBe(false)
      expect(last.status.lastPollAt).not.toBeNull()
    }
    h.svc.stop()
  })

  it('drops a PR that becomes approved on the next poll', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    expect(h.svc.list()).toHaveLength(1)

    h.setPrs([rawPr({ pullRequestId: 1, reviewers: [{ id: 'me-1', displayName: 'Ada', vote: 10, isRequired: true }] })])
    await nextPoll()
    expect(h.svc.list()).toHaveLength(0)
    h.svc.stop()
  })

  it('refresh() polls right away and does not re-enter while one is running', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    const before = h.urls.length

    await Promise.all([h.svc.refresh(), h.svc.refresh()])
    // One extra pullrequests call — connectionData is cached in `me`.
    expect(h.urls.length).toBe(before + 1)
    h.svc.stop()
  })

  it('stop() ends the loop', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    const after = h.urls.length
    h.svc.stop()
    await vi.advanceTimersByTimeAsync(POLL.prsMs * 5)
    expect(h.urls.length).toBe(after)
  })
})

describe('PrService — errors and backoff', () => {
  it('surfaces the mapped error and keeps the previous list', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    expect(h.svc.list()).toHaveLength(1)

    h.failNext({ status: 401, headers: { get: () => null }, text: async () => '' })
    await nextPoll()
    expect(h.svc.status().error).toEqual({ code: 'unauthorized', detail: 'Azure DevOps rejected the token' })
    expect(h.svc.list()).toHaveLength(1)
    h.svc.stop()
  })

  it('backs off exponentially and recovers on the next success', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    // Every call fails: the connectionData probe is the first casualty.
    const fail = (): AdoResponse => ({ status: 500, headers: { get: () => null }, text: async () => 'boom' })
    h.failNext(fail())
    await firstPoll()
    expect(h.svc.status().error?.code).toBe('http')

    // Next attempt is 2 × prsMs away, not prsMs.
    const at = h.urls.length
    await vi.advanceTimersByTimeAsync(POLL.prsMs)
    expect(h.urls.length).toBe(at)
    await vi.advanceTimersByTimeAsync(POLL.prsMs)
    expect(h.urls.length).toBeGreaterThan(at)

    // That attempt succeeded, so the cadence is back to prsMs.
    expect(h.svc.status().error).toBeNull()
    const at2 = h.urls.length
    await vi.advanceTimersByTimeAsync(POLL.prsMs)
    expect(h.urls.length).toBeGreaterThan(at2)
    h.svc.stop()
  })

  it('never lets the backoff exceed the ceiling', async () => {
    const h = harness()
    h.failAlways(new Error('net::ERR_CONNECTION_REFUSED'))
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    // 3 s → fail 1, +2×60 s → fail 2, +4×60 s → fail 3, +8×60 s → fail 4.
    await firstPoll()
    await vi.advanceTimersByTimeAsync(2 * POLL.prsMs)
    await vi.advanceTimersByTimeAsync(4 * POLL.prsMs)
    await vi.advanceTimersByTimeAsync(8 * POLL.prsMs)
    expect(h.svc.status().error?.code).toBe('network')

    // 16 × 60 s would be 16 min: the ceiling holds it at 10.
    const at = h.urls.length
    await vi.advanceTimersByTimeAsync(POLL.prsBackoffMaxMs - 1)
    expect(h.urls.length).toBe(at)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.urls.length).toBe(at + 1)

    // …and stays there rather than creeping up.
    const at2 = h.urls.length
    await vi.advanceTimersByTimeAsync(POLL.prsBackoffMaxMs)
    expect(h.urls.length).toBe(at2 + 1)
    h.svc.stop()
  })
})

describe('PrService — notifications', () => {
  it('toasts one new PR with the #id · repo wording', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await firstPoll()

    h.setPrs([rawPr({ pullRequestId: 42, title: 'Fix the thing' })])
    await nextPoll()
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('Pull request #42 · api')
    expect(notifications[0].body).toBe('Fix the thing — Grace')
    h.svc.stop()
  })

  it('toasts N new PRs with the first three titles', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await firstPoll()

    h.setPrs([1, 2, 3, 4].map((n) => rawPr({ pullRequestId: n, title: `T${n}` })))
    await nextPoll()
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('4 new pull requests need review')
    expect(notifications[0].body).toBe('T1\nT2\nT3')
    h.svc.stop()
  })

  it('clicking the toast pushes {kind:"prs-open"}', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await firstPoll()
    h.setPrs([rawPr({ pullRequestId: 7 })])
    await nextPoll()

    notifications[0].clicks.forEach((cb) => cb())
    expect(h.pushes.some((m) => m.kind === 'prs-open')).toBe(true)
    h.svc.stop()
  })

  it('stays quiet while the window is focused', async () => {
    const h = harness()
    h.focused.value = true
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await firstPoll()
    h.setPrs([rawPr({ pullRequestId: 1 })])
    await nextPoll()
    expect(notifications).toHaveLength(0)
    expect(h.svc.list()).toHaveLength(1) // still pushed in-app
    h.svc.stop()
  })

  it('never toasts a PR I authored', async () => {
    const h = harness()
    h.store.writeSecretJson('prs-token', personal('my-own-token'))
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await firstPoll()
    h.setPrs([rawPr({ pullRequestId: 1, createdBy: { id: 'me-1', displayName: 'Ada' } })])
    await nextPoll()
    expect(notifications).toHaveLength(0)
    h.svc.stop()
  })

  // On the team's shared token the polled identity is whoever configured the
  // group, not the reader — suppressing by it would eat the toasts for their
  // pull requests and toast me about my own.
  it('suppresses nothing when the identity is the shared token owner', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await firstPoll()
    expect(h.svc.status().tokenSource).toBe('shared')
    h.setPrs([
      rawPr({ pullRequestId: 1, createdBy: { id: 'me-1', displayName: 'Ada' } }), // the token owner's
      rawPr({ pullRequestId: 2 }),
    ])
    await nextPoll()
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('2 new pull requests need review')
    h.svc.stop()
  })

  it('never toasts the same PR twice', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await firstPoll()
    h.setPrs([rawPr({ pullRequestId: 1 })])
    await nextPoll()
    await nextPoll()
    expect(notifications).toHaveLength(1)
    h.svc.stop()
  })

  it('skips the first poll after I publish a config myself', async () => {
    const h = harness()
    h.svc.start()
    h.setPrs([rawPr({ pullRequestId: 1 })])
    await h.svc.saveConfig({
      baseUrl: 'https://dev.azure.com/acme',
      project: 'Proj',
      repos: [{ id: 'r1', name: 'api' }],
      token: 'tok',
      shareToken: true,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.svc.list()).toHaveLength(1)
    expect(notifications).toHaveLength(0)

    // The suppression is one poll deep, not permanent.
    h.setPrs([rawPr({ pullRequestId: 1 }), rawPr({ pullRequestId: 2 })])
    await nextPoll()
    expect(notifications).toHaveLength(1)
    h.svc.stop()
  })
})

describe('PrService — the seen set', () => {
  it('markSeen persists to prs-seen, zeroes unseen and pushes', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    expect(h.svc.status().unseen).toBe(1)

    h.svc.markSeen(['r1:1', 'not-a-tracked-key'])
    expect(h.svc.status().unseen).toBe(0)
    expect(h.svc.list()[0].seen).toBe(true)
    expect(h.store.readSecretJson('prs-seen')).toEqual({ 'r1:1': true })
    h.svc.stop()
  })

  it('the first poll of a session is a silent catch-up, later arrivals toast', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    // Already pending at launch: counted as unseen, never toasted.
    expect(notifications).toHaveLength(0)
    expect(h.svc.status().unseen).toBe(1)

    h.setPrs([rawPr({ pullRequestId: 1 }), rawPr({ pullRequestId: 2 })])
    await nextPoll()
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('Pull request #2 · api')
    h.svc.stop()
  })

  it('a seen PR is not re-announced', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await firstPoll()
    h.setPrs([rawPr({ pullRequestId: 1 })])
    await nextPoll()
    expect(notifications).toHaveLength(1) // the very first appearance only
    h.svc.markSeen(['r1:1'])

    notifications.length = 0
    await nextPoll()
    expect(notifications).toHaveLength(0)
    expect(h.svc.list()[0].seen).toBe(true)
    h.svc.stop()
  })

  it('status reports whether the team config carries a shared token', async () => {
    const h = harness()
    h.chat.append(configEvent({ sharedToken: '' }), 'someone')
    h.svc.start()
    await firstPoll()
    expect(h.svc.status().sharedTokenSet).toBe(false)
    h.chat.append(configEvent(), 'someone')
    await nextPoll()
    expect(h.svc.status().sharedTokenSet).toBe(true)
    h.svc.stop()
  })

  it('prunes prs-seen down to the keys still tracked', async () => {
    const h = harness()
    h.store.writeSecretJson('prs-seen', { 'r1:1': true, 'r1:999': true })
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    expect(h.store.readSecretJson('prs-seen')).toEqual({ 'r1:1': true })
    expect(h.svc.list()[0].seen).toBe(true)
    expect(h.svc.status().unseen).toBe(0)
    h.svc.stop()
  })
})

describe('PrService — prefs RPCs', () => {
  it('testConnection returns the user and the projects', async () => {
    const h = harness()
    const probe = await h.svc.testConnection({ baseUrl: 'https://dev.azure.com/acme/', token: ' tok ' })
    expect(probe).toEqual({
      ok: true,
      me: { id: 'me-1', name: 'Ada' },
      projects: [{ id: 'p1', name: 'Proj' }],
    })
  })

  it('testConnection rejects a URL that carries credentials or is not http(s)', async () => {
    const h = harness()
    for (const baseUrl of ['ssh://git@dev.azure.com/acme', 'https://user:pw@dev.azure.com/acme', 'nonsense']) {
      const probe = await h.svc.testConnection({ baseUrl, token: 'tok' })
      expect(probe.ok).toBe(false)
      if (!probe.ok) expect(probe.error.code).toBe('bad-url')
    }
    expect(h.urls).toEqual([])
  })

  it('listRepos strips refs/heads/ from the default branch', async () => {
    const h = harness()
    const res = await h.svc.listRepos({ baseUrl: 'https://dev.azure.com/acme', token: 'tok', project: 'Proj' })
    expect(res).toEqual({ ok: true, value: [{ id: 'r1', name: 'api', defaultBranch: 'main' }] })
  })

  it('testConnection prefills the personal token only for the server it belongs to', async () => {
    const h = harness()
    h.store.writeSecretJson('prs-token', personal('PERSONAL-PAT'))
    h.chat.append(configEvent({ sharedToken: '' }), 'someone')
    h.svc.start()

    const elsewhere = await h.svc.testConnection({ baseUrl: 'https://tfs.corp/tfs', token: '' })
    expect(elsewhere.ok).toBe(false)
    if (!elsewhere.ok) expect(elsewhere.error.code).toBe('unauthorized')
    expect(h.urls).toEqual([]) // nothing was sent to that host

    const here = await h.svc.testConnection({ baseUrl: 'https://dev.azure.com/acme', token: '' })
    expect(here.ok).toBe(true)
    expect(h.tokens).toEqual(['PERSONAL-PAT', 'PERSONAL-PAT']) // connectionData + projects
    h.svc.stop()
  })

  it('setPersonalToken writes the secret against the configured server, then deletes it', () => {
    const h = harness()
    h.chat.append(configEvent({ sharedToken: '' }), 'someone')
    h.svc.start()
    h.svc.setPersonalToken('  personal  ')
    expect(h.store.readSecretJson('prs-token')).toEqual(personal('personal'))
    expect(h.svc.status().tokenSource).toBe('personal')
    h.svc.setPersonalToken(null)
    expect(h.store.data.has('prs-token')).toBe(false)
    expect(h.svc.status().tokenSource).toBe('none')
    h.svc.stop()
  })

  it('a token entered before anything is configured has no server to belong to and is not kept', () => {
    const h = harness()
    h.svc.start()
    h.svc.setPersonalToken('personal')
    expect(h.store.data.has('prs-token')).toBe(false)
    expect(h.svc.status().tokenSource).toBe('none')
    h.svc.stop()
  })
})

describe('PrService — the personal token belongs to one server', () => {
  it('is not sent to a base URL somebody else published', async () => {
    const h = harness()
    h.store.writeSecretJson('prs-token', personal('PERSONAL-PAT'))
    h.chat.append(configEvent({ sharedToken: '' }), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    expect(h.tokens).toContain('PERSONAL-PAT') // the server it was entered for

    // Anyone holding the team passphrase can publish a config. Pointing it at
    // another host must not hand them this machine's credential.
    const before = h.urls.length
    h.chat.append(configEvent({ baseUrl: 'http://collector.attacker.tld', sharedToken: '' }), 'someone-else')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.urls.slice(before)).toEqual([])
    expect(h.svc.status().tokenSource).toBe('none') // the pane asks for a token instead
    expect(h.svc.status().error).toBeNull()

    // …and a token typed for that server is stored for that server only.
    h.svc.setPersonalToken('NEW-PAT')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.store.readSecretJson('prs-token')).toEqual(personal('NEW-PAT', 'http://collector.attacker.tld'))
    expect(h.urls.slice(before).every((u) => u.startsWith('http://collector.attacker.tld/'))).toBe(true)
    expect(h.tokens.slice(before)).not.toContain('PERSONAL-PAT')
    h.svc.stop()
  })

  it('falls back to the shared token when the config points somewhere else', async () => {
    const h = harness()
    h.store.writeSecretJson('prs-token', personal('PERSONAL-PAT'))
    h.chat.append(configEvent({ baseUrl: 'https://tfs.corp/tfs' }), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    expect(h.svc.status().tokenSource).toBe('shared')
    expect(h.tokens).toContain('shared-token-value')
    expect(h.tokens).not.toContain('PERSONAL-PAT')
    h.svc.stop()
  })

  it('saveConfig binds the token to the base URL the user typed', async () => {
    const h = harness()
    h.svc.start()
    await h.svc.saveConfig({
      baseUrl: 'https://tfs.corp:8080/tfs/DefaultCollection/',
      project: 'Proj',
      repos: [{ id: 'r1', name: 'api' }],
      token: 'tok',
      shareToken: false,
    })
    expect(h.store.readSecretJson('prs-token')).toEqual(personal('tok', 'https://tfs.corp:8080'))
    expect(h.svc.status().tokenSource).toBe('personal')
    h.svc.stop()
  })
})

describe('PrService — state changing under a poll in flight', () => {
  it('a token change mid-poll is dropped, not reported as a network failure', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()

    const release = h.holdPrs()
    const inFlight = h.svc.refresh()
    await vi.advanceTimersByTimeAsync(0)
    h.svc.setPersonalToken('fresh-token')
    release()
    await inFlight
    expect(h.svc.status().error).toBeNull()

    // The immediate poll the token change asked for is not swallowed by the
    // re-entrancy guard, and it goes out with the new token.
    await vi.advanceTimersByTimeAsync(0)
    expect(h.tokens.at(-1)).toBe('fresh-token')
    expect(h.svc.status().error).toBeNull()
    expect(h.svc.list().map((p) => p.id)).toEqual([1])
    h.svc.stop()
  })

  it('a disconnect mid-poll neither resurrects the list nor invents an error', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()

    const release = h.holdPrs()
    const inFlight = h.svc.refresh()
    await vi.advanceTimersByTimeAsync(0)
    await h.svc.disconnect()
    release()
    await inFlight
    expect(h.svc.status().error).toBeNull()
    expect(h.svc.list()).toEqual([])

    await vi.advanceTimersByTimeAsync(0)
    expect(h.svc.status().configured).toBe(false)
    expect(h.svc.status().error).toBeNull()
    h.svc.stop()
  })

  it('a markSeen during a poll survives the poll installing its list', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    expect(h.svc.status().unseen).toBe(1)

    const release = h.holdPrs()
    const inFlight = h.svc.refresh()
    await vi.advanceTimersByTimeAsync(0)
    h.svc.markSeen(['r1:1'])
    expect(h.svc.status().unseen).toBe(0)
    release()
    await inFlight

    expect(h.svc.status().unseen).toBe(0)
    expect(h.svc.list()[0].seen).toBe(true)
    expect(h.store.readSecretJson('prs-seen')).toEqual({ 'r1:1': true })
    h.svc.stop()
  })
})

describe('PrService — writes to the team log', () => {
  it('saveConfig publishes the full snapshot and keeps a personal copy of the token', async () => {
    const h = harness()
    h.svc.start()
    await h.svc.saveConfig({
      baseUrl: 'https://dev.azure.com/acme/',
      project: ' Proj ',
      repos: [
        { id: 'r1', name: 'api' },
        { id: '', name: 'nameless' },
      ],
      token: ' tok ',
      shareToken: true,
    })
    expect(h.chat.published).toHaveLength(1)
    expect(h.chat.published[0].conv).toBe(TEAM_CONV.prs)
    expect(h.chat.published[0].type).toBe('prs')
    expect(h.chat.published[0].payload).toEqual({
      t: 'prs',
      conv: TEAM_CONV.prs,
      config: {
        baseUrl: 'https://dev.azure.com/acme',
        project: 'Proj',
        repos: [{ id: 'r1', name: 'api' }],
        sharedToken: 'tok',
      },
    })
    // Even when shared: un-sharing later must not lock the configurer out.
    expect(h.store.readSecretJson('prs-token')).toEqual(personal('tok'))
    h.svc.stop()
  })

  it('saveConfig with shareToken false publishes an empty sharedToken', async () => {
    const h = harness()
    h.svc.start()
    await h.svc.saveConfig({
      baseUrl: 'https://dev.azure.com/acme',
      project: 'Proj',
      repos: [{ id: 'r1', name: 'api' }],
      token: 'tok',
      shareToken: false,
    })
    const payload = h.chat.published[0].payload as PrsPayload
    expect(payload.config.sharedToken).toBe('')
    expect(h.svc.status().tokenSource).toBe('personal')
    h.svc.stop()
  })

  it('saveConfig with an empty token keeps the token the team already shares', async () => {
    const h = harness()
    h.chat.append(configEvent(), 'someone')
    h.svc.start()
    await h.svc.saveConfig({
      baseUrl: 'https://dev.azure.com/acme',
      project: 'Proj',
      repos: [{ id: 'r1', name: 'api' }],
      token: '',
      shareToken: true,
    })
    const payload = h.chat.published[0].payload as PrsPayload
    expect(payload.config.sharedToken).toBe('shared-token-value')
    expect(h.store.data.has('prs-token')).toBe(false)
    h.svc.stop()
  })

  it('saveConfig refuses an unusable config', async () => {
    const h = harness()
    const base = { baseUrl: 'https://dev.azure.com/acme', project: 'Proj', repos: [{ id: 'r1', name: 'api' }], token: 't', shareToken: false }
    await expect(h.svc.saveConfig({ ...base, baseUrl: 'not a url' })).rejects.toThrow(/invalid-config/)
    await expect(h.svc.saveConfig({ ...base, project: '  ' })).rejects.toThrow(/invalid-config/)
    await expect(h.svc.saveConfig({ ...base, repos: [] })).rejects.toThrow(/invalid-config/)
    expect(h.chat.published).toHaveLength(0)
  })

  it('disconnect publishes an empty config, clears prs-seen and keeps the personal token', async () => {
    const h = harness()
    h.store.writeSecretJson('prs-token', personal('mine'))
    h.chat.append(configEvent(), 'someone')
    h.setPrs([rawPr({ pullRequestId: 1 })])
    h.svc.start()
    await firstPoll()
    h.svc.markSeen(['r1:1'])
    expect(h.store.data.has('prs-seen')).toBe(true)

    await h.svc.disconnect()
    const payload = h.chat.published[0].payload as PrsPayload
    expect(payload.config).toEqual({ baseUrl: '', project: '', repos: [], sharedToken: '' })
    expect(h.store.data.has('prs-seen')).toBe(false)
    expect(h.store.readSecretJson('prs-token')).toEqual(personal('mine'))
    expect(h.svc.list()).toEqual([])
    expect(h.svc.status().configured).toBe(false)
    h.svc.stop()
  })
})
