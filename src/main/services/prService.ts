import { Notification, net } from 'electron'
import type { BrowserWindow } from 'electron'
import type { PushMessage } from '@shared/bridge'
import type { AdoResult, ConvId, PrsConfig, PrsProbe, PrsRepo, PrsStatus, PrView } from '@shared/types'
import { POLL, TEAM_CONV } from '@shared/constants'
import { baseUrlOrigin, isTracked, materializePrsConfig, normalizeBaseUrl, toPrView } from '@shared/prs'
import { AdoClient, type AdoRepo, type AdoResponse, type FetchLike } from './ado'
import type { SecretStore } from '../store/secretStore'
import type { ChatService } from './chatService'

// The pull-request group. Three pieces of state with three different homes:
//
//   • the config (base URL, project, watched repos, optional shared token)
//     lives in the `team:prs` event log — encrypted under the team key, so
//     "available for the entire team" is literal;
//   • the personal token lives in the local secret 'prs-token' and never
//     leaves the machine (and is NOT cleared by changeTeamFolder — it is the
//     user's, not the team's). It is stored together with the origin it was
//     entered for and is only ever sent there: the config is a shared,
//     teammate-writable document, so a base URL pointing somewhere else must
//     not be able to redirect this machine's own credential;
//   • the seen set lives in 'prs-seen', pruned to the tracked keys every poll
//     so a merged PR cannot keep a row in it forever.
//
// Polling is a self-rescheduling setTimeout, never setInterval: a slow or
// hanging ADO call must not queue a second poll behind it. Errors back off
// exponentially to POLL.prsBackoffMaxMs so an expired PAT does not hammer a
// corporate proxy once a minute all day.

const TOKEN_SECRET = 'prs-token'
const SEEN_SECRET = 'prs-seen'

/** Let the share catch up and the window settle before the first network call. */
const FIRST_POLL_MS = 3_000
const MAX_BACKOFF_STEPS = 8

const EMPTY_CONFIG: PrsConfig = { baseUrl: '', project: '', repos: [], sharedToken: '' }

/** The personal PAT plus the `protocol//host` it was entered for. */
interface PersonalToken {
  token: string
  origin: string
}

/**
 * Electron's proxy-aware fetch — never `node:https` or global fetch, which
 * ignore the system proxy and the enterprise trust store that on-prem Azure
 * DevOps usually sits behind.
 */
function electronFetch(): FetchLike {
  return (url, init) =>
    net.fetch(url, {
      headers: init.headers,
      signal: init.signal,
      credentials: 'omit',
      bypassCustomProtocolHandlers: true,
    }) as unknown as Promise<AdoResponse>
}

function sameConfig(a: PrsConfig, b: PrsConfig): boolean {
  return (
    a.baseUrl === b.baseUrl &&
    a.project === b.project &&
    a.sharedToken === b.sharedToken &&
    a.repos.length === b.repos.length &&
    a.repos.every((r, i) => r.id === b.repos[i].id && r.name === b.repos[i].name)
  )
}

export class PrService {
  private stopped = true
  private timer: NodeJS.Timeout | null = null
  /** Re-entrancy guard: refresh() and the timer can land together. */
  private running = false
  private failures = 0

  private config: PrsConfig = EMPTY_CONFIG
  private personal: PersonalToken | null = null
  private seen: Record<string, true> = {}
  /**
   * Bumped whenever the credential or the collection changes. A poll snapshots
   * it before its round-trips and disowns its results if it moved: those
   * answers came from the previous identity, and `me` may already be null
   * under them.
   */
  private configGen = 0

  private prs: PrView[] = []
  private prevKeys = new Set<string>()
  private me: { id: string; name: string } | null = null
  private lastPollAt: number | null = null
  private polling = false
  private error: PrsStatus['error'] = null
  /** Set by saveConfig: the configurer just looked at the list, don't toast it back. */
  private skipNotifyOnce = false
  /**
   * The first successful poll of a session is a catch-up, not news: a machine
   * woken with the app in the background must not toast every PR that was
   * already pending. The badge/unseen count still reflect them.
   */
  private caughtUp = false

  private readonly fetchImpl: FetchLike

  constructor(
    private chat: ChatService,
    private store: SecretStore,
    private getWindow: () => BrowserWindow | null,
    private push: (m: PushMessage) => void,
    private getVersion: () => string,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? electronFetch()
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.caughtUp = false
    this.personal = this.readToken()
    this.seen = this.readSeen()
    this.chat.events.onEvent((conv: ConvId) => {
      if (this.stopped || conv !== TEAM_CONV.prs) return
      this.applyConfig(false)
    })
    this.applyConfig(true)
    this.schedule(FIRST_POLL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  // -------------------------------------------------------------------------
  // Reads

  status(): PrsStatus {
    return {
      configured: this.configured(),
      baseUrl: this.config.baseUrl,
      project: this.config.project,
      repos: this.config.repos.map((r) => ({ id: r.id, name: r.name })),
      tokenSource: this.tokenSource(),
      sharedTokenSet: this.config.sharedToken !== '',
      me: this.me ? { id: this.me.id, name: this.me.name } : null,
      lastPollAt: this.lastPollAt,
      polling: this.polling,
      error: this.error,
      unseen: this.prs.reduce((n, p) => n + (p.seen ? 0 : 1), 0),
    }
  }

  list(): PrView[] {
    return this.prs.slice()
  }

  private configured(): boolean {
    // materializePrsConfig returns the disconnect snapshot (baseUrl '') rather
    // than null, so "configured" is a property of the config, not of its
    // presence.
    return this.config.baseUrl !== '' && this.config.repos.length > 0
  }

  private tokenSource(): PrsStatus['tokenSource'] {
    if (this.personalTokenHere()) return 'personal'
    if (this.config.sharedToken) return 'shared'
    return 'none'
  }

  private token(): string {
    return this.personalTokenHere() ?? this.config.sharedToken ?? ''
  }

  /**
   * The personal token, but only for the server it was entered for. Anyone
   * holding the team passphrase can publish a config, so an unbound personal
   * token would let a single `prs` event point every teammate's PAT at a host
   * of the author's choosing. A base URL this machine has not approved falls
   * back to the shared token, or to the pane's "enter your token" state.
   */
  private personalTokenHere(): string | null {
    if (!this.personal) return null
    const origin = baseUrlOrigin(this.config.baseUrl)
    return origin !== null && origin === this.personal.origin ? this.personal.token : null
  }

  private ua(): string {
    return `Chat/${this.getVersion()}`
  }

  // -------------------------------------------------------------------------
  // Config log

  private applyConfig(initial: boolean): void {
    const mat = materializePrsConfig(this.chat.getEvents(TEAM_CONV.prs))
    const next = mat ? mat.config : EMPTY_CONFIG
    if (sameConfig(next, this.config)) return
    const rebind = next.baseUrl !== this.config.baseUrl || next.sharedToken !== this.config.sharedToken
    this.config = next
    this.configGen += 1 // a poll in flight is answering for the old config
    if (rebind) this.me = null // a different collection or credential: re-identify
    this.error = null
    if (initial) return
    this.pushState()
    this.schedule(0) // a config change is worth an immediate poll
  }

  // -------------------------------------------------------------------------
  // Polling

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.poll()
    }, ms)
    this.timer.unref?.()
  }

  private nextDelayMs(): number {
    if (this.failures === 0) return POLL.prsMs
    const steps = Math.min(this.failures, MAX_BACKOFF_STEPS)
    return Math.min(POLL.prsMs * 2 ** steps, POLL.prsBackoffMaxMs)
  }

  /** Immediate poll (the pane's ↻ button). Never throws. */
  async refresh(): Promise<void> {
    await this.poll()
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.running) return
    const gen = this.configGen
    this.running = true
    this.polling = true
    this.pushState()
    try {
      const ok = await this.doPoll(gen)
      // null: the config or the credential changed under the poll. Its answers
      // are not evidence about the new one, so neither the error nor the
      // backoff counter may be touched — and the immediate poll the change
      // asked for was swallowed by the re-entrancy guard, so the finally
      // below runs it now.
      if (ok !== null) this.failures = ok ? 0 : this.failures + 1
    } catch {
      // Nothing here should throw — a bug in the diff must not kill the loop.
      // The thrown message is a JS error, not a diagnosis: it never gets dressed
      // up as one, and no unvetted string rides out to the pane.
      this.failures += 1
      this.error = { code: 'network', detail: 'The pull-request poll failed unexpectedly' }
    } finally {
      this.running = false
      this.polling = false
      this.schedule(this.configGen === gen ? this.nextDelayMs() : 0)
      this.pushState()
    }
  }

  /**
   * Returns false when the poll failed (so the caller can back off), null when
   * the config or the credential changed while it was in flight.
   */
  private async doPoll(gen: number): Promise<boolean | null> {
    if (!this.configured() || !this.token()) {
      // Not set up, or nobody has supplied a token yet: both are UI states in
      // the pane, not error strips.
      this.prs = []
      this.prevKeys = new Set()
      this.error = null
      return true
    }

    const client = new AdoClient(this.fetchImpl, {
      baseUrl: this.config.baseUrl,
      token: this.token(),
      userAgent: this.ua(),
    })

    if (!this.me) {
      const who = await client.me()
      if (gen !== this.configGen) return null
      if (!who.ok) {
        this.error = who.error
        return false
      }
      this.me = who.value
    }

    // Snapshot the identity: `this.me` can be nulled from outside (a token
    // change, a disconnect, a teammate's config landing) across the awaits
    // below, and TypeScript keeps the narrowing right over them.
    const meId = this.me.id
    const seenSet = new Set(Object.keys(this.seen))
    const views: PrView[] = []
    for (const repo of this.config.repos) {
      const res = await client.activePullRequests(this.config.project, repo.id)
      if (gen !== this.configGen) return null
      if (!res.ok) {
        this.error = res.error
        return false // keep the previous list on screen rather than blanking it
      }
      for (const raw of res.value) {
        const view = toPrView(raw, {
          baseUrl: this.config.baseUrl,
          project: this.config.project,
          meId,
          seen: seenSet,
        })
        if (isTracked({ isDraft: view.isDraft, status: raw.status, reviewers: view.reviewers })) views.push(view)
      }
    }
    views.sort((a, b) => b.createdAt - a.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

    const keys = new Set(views.map((v) => v.key))
    this.pruneSeen(keys)

    // The seen flags come from the live set, not from `seenSet`: a markSeen()
    // that landed during the round-trips above is already in `this.seen`, and
    // installing the pre-fetch snapshot over it would flip those rows back to
    // unseen with no way left to correct them (a repeat markSeen with the same
    // keys is a no-op, and the pane only re-arms when the key set changes).
    const list = views.map((v) => (this.seen[v.key] === true && !v.seen ? { ...v, seen: true } : v))

    // "New" = appeared since the last poll AND never marked seen. A PR that
    // goes approved/completed/abandoned/draft simply stops being tracked and
    // drops out of the list on the next poll.
    const fresh = list.filter((v) => !v.seen && !this.prevKeys.has(v.key))

    this.prs = list
    this.prevKeys = keys
    this.lastPollAt = Date.now()
    this.error = null

    const skip = this.skipNotifyOnce || !this.caughtUp
    this.skipNotifyOnce = false
    this.caughtUp = true
    if (fresh.length && !skip) this.notify(fresh)
    return true
  }

  private notify(fresh: PrView[]): void {
    const win = this.getWindow()
    if (win?.isFocused()) return // the in-app PrAlert covers the focused case
    // Never toast my own PR — but only when the identity behind the poll really
    // is mine. On the team's shared token `this.me` is whoever configured the
    // group, and suppressing by their id would invert the filter: it would eat
    // the toasts for their pull requests and toast me about my own.
    const mine = this.tokenSource() === 'personal' ? (this.me?.id ?? '') : ''
    const others = mine === '' ? fresh : fresh.filter((p) => p.author.id !== mine)
    if (!others.length) return
    if (!Notification.isSupported()) return

    const one = others[0]
    const title =
      others.length === 1
        ? `Pull request #${one.id} · ${one.repoName}`
        : `${others.length} new pull requests need review`
    const body =
      others.length === 1
        ? `${one.title} — ${one.author.name}`
        : others
            .slice(0, 3)
            .map((p) => p.title)
            .join('\n')

    const n = new Notification({ title, body, silent: false })
    n.on('click', () => {
      const w = this.getWindow()
      w?.show()
      w?.focus()
      this.push({ kind: 'prs-open' })
    })
    n.show()
  }

  // -------------------------------------------------------------------------
  // Seen set

  private readSeen(): Record<string, true> {
    const raw = this.store.readSecretJson<Record<string, unknown>>(SEEN_SECRET)
    if (!raw || typeof raw !== 'object') return {}
    const out: Record<string, true> = {}
    for (const k of Object.keys(raw)) if (typeof k === 'string' && k) out[k] = true
    return out
  }

  private pruneSeen(keys: Set<string>): void {
    let changed = false
    for (const k of Object.keys(this.seen)) {
      if (!keys.has(k)) {
        delete this.seen[k]
        changed = true
      }
    }
    if (changed) this.store.writeSecretJson(SEEN_SECRET, this.seen)
  }

  markSeen(keys: string[]): void {
    const tracked = new Set(this.prs.map((p) => p.key))
    let changed = false
    for (const k of Array.isArray(keys) ? keys : []) {
      if (typeof k !== 'string' || !tracked.has(k) || this.seen[k]) continue
      this.seen[k] = true
      changed = true
    }
    if (changed) this.store.writeSecretJson(SEEN_SECRET, this.seen)
    // Reconcile against `this.seen` rather than against `changed`, so a row
    // whose flag disagrees with the persisted set is repaired even when this
    // call added nothing.
    const list = this.prs.map((p) => (this.seen[p.key] && !p.seen ? { ...p, seen: true } : p))
    if (!changed && list.every((p, i) => p === this.prs[i])) return
    this.prs = list
    this.pushState()
  }

  // -------------------------------------------------------------------------
  // Token

  private readToken(): PersonalToken | null {
    const raw = this.store.readSecretJson<unknown>(TOKEN_SECRET)
    if (!raw || typeof raw !== 'object') return null
    const rec = raw as { token?: unknown; origin?: unknown }
    const token = typeof rec.token === 'string' ? rec.token.trim() : ''
    const origin = typeof rec.origin === 'string' ? baseUrlOrigin(rec.origin) : null
    return token && origin ? { token, origin } : null
  }

  /**
   * Store the token against a base URL the *user* supplied — the one typed in
   * the prefs pane, or the one the pane was showing when they pasted a token
   * for a group somebody else set up. It is never re-bound from the log.
   */
  private writeToken(token: string, baseUrl: string): void {
    const origin = baseUrlOrigin(baseUrl)
    this.personal = origin ? { token, origin } : null
    if (this.personal) this.store.writeSecretJson(TOKEN_SECRET, this.personal)
    else this.store.deleteSecret(TOKEN_SECRET)
  }

  setPersonalToken(token: string | null): void {
    const t = typeof token === 'string' ? token.trim() : ''
    if (t) this.writeToken(t, this.config.baseUrl)
    else {
      this.personal = null
      this.store.deleteSecret(TOKEN_SECRET)
    }
    this.me = null
    this.configGen += 1
    this.error = null
    this.pushState()
    this.schedule(0)
  }

  // -------------------------------------------------------------------------
  // Prefs-pane RPCs (throwaway clients — none of this touches the poll state)

  /**
   * An empty token falls back to the effective one, so "Test" works on a
   * prefill — but the personal token falls back only for the server it belongs
   * to, exactly as in a poll. Probing a different host takes a typed token.
   */
  private probeToken(input: { token?: unknown }, baseUrl: string): string {
    const given = typeof input?.token === 'string' ? input.token.trim() : ''
    if (given) return given
    const origin = baseUrlOrigin(baseUrl)
    if (this.personal && origin !== null && origin === this.personal.origin) return this.personal.token
    return this.config.sharedToken ?? ''
  }

  async testConnection(input: { baseUrl: string; token: string }): Promise<PrsProbe> {
    const baseUrl = normalizeBaseUrl(String(input?.baseUrl ?? ''))
    if (!baseUrl) {
      return { ok: false, error: { code: 'bad-url', detail: 'Enter a URL like https://dev.azure.com/your-org' } }
    }
    const token = this.probeToken(input, baseUrl)
    if (!token) {
      return { ok: false, error: { code: 'unauthorized', detail: 'Enter an Azure DevOps personal access token' } }
    }
    const client = new AdoClient(this.fetchImpl, { baseUrl, token, userAgent: this.ua() })
    const me = await client.me()
    if (!me.ok) return { ok: false, error: me.error }
    const projects = await client.projects()
    if (!projects.ok) return { ok: false, error: projects.error }
    return { ok: true, me: me.value, projects: projects.value }
  }

  async listRepos(input: { baseUrl: string; token: string; project: string }): Promise<AdoResult<AdoRepo[]>> {
    const baseUrl = normalizeBaseUrl(String(input?.baseUrl ?? ''))
    if (!baseUrl) {
      return { ok: false, error: { code: 'bad-url', detail: 'Enter a URL like https://dev.azure.com/your-org' } }
    }
    const project = String(input?.project ?? '').trim()
    if (!project) return { ok: false, error: { code: 'not-found', detail: 'Choose a project first' } }
    const token = this.probeToken(input, baseUrl)
    if (!token) {
      return { ok: false, error: { code: 'unauthorized', detail: 'Enter an Azure DevOps personal access token' } }
    }
    return new AdoClient(this.fetchImpl, { baseUrl, token, userAgent: this.ua() }).repos(project)
  }

  // -------------------------------------------------------------------------
  // Writes to the team log

  async saveConfig(input: {
    baseUrl: string
    project: string
    repos: PrsRepo[]
    token: string
    shareToken: boolean
  }): Promise<void> {
    const baseUrl = normalizeBaseUrl(String(input?.baseUrl ?? ''))
    if (!baseUrl) throw new Error('invalid-config: base URL must be http(s) and carry no credentials')
    const project = String(input?.project ?? '').trim()
    if (!project) throw new Error('invalid-config: project is required')
    const repos = (Array.isArray(input?.repos) ? input.repos : [])
      .map((r) => ({ id: String(r?.id ?? '').trim(), name: String(r?.name ?? '').trim() }))
      .filter((r) => r.id !== '' && r.name !== '')
    if (repos.length === 0) throw new Error('invalid-config: pick at least one repository')

    const token = typeof input?.token === 'string' ? input.token.trim() : ''
    const shareToken = input?.shareToken === true
    const config: PrsConfig = {
      baseUrl,
      project,
      repos,
      // Saving with an empty token keeps whatever the team already shares.
      sharedToken: shareToken ? token || this.config.sharedToken : '',
    }

    // Keep a personal copy even when sharing: un-sharing later must not lock
    // the person who set it up out of their own group.
    if (token) {
      this.writeToken(token, baseUrl)
      this.me = null
      this.configGen += 1
    }

    this.skipNotifyOnce = true
    try {
      await this.chat.publishTeam(TEAM_CONV.prs, 'prs', { t: 'prs', conv: TEAM_CONV.prs, config })
    } catch (err) {
      this.skipNotifyOnce = false
      throw err
    }
  }

  /** Publish an empty config and clear the seen set; the personal token stays. */
  async disconnect(): Promise<void> {
    await this.chat.publishTeam(TEAM_CONV.prs, 'prs', {
      t: 'prs',
      conv: TEAM_CONV.prs,
      config: { baseUrl: '', project: '', repos: [], sharedToken: '' },
    })
    this.seen = {}
    this.store.deleteSecret(SEEN_SECRET)
    this.prs = []
    this.prevKeys = new Set()
    this.me = null
    this.configGen += 1
    this.error = null
    this.pushState()
  }

  // -------------------------------------------------------------------------

  private pushState(): void {
    this.push({ kind: 'prs', prs: this.list(), status: this.status() })
  }
}
