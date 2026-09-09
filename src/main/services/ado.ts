import type { AdoError, AdoErrorCode, AdoResult } from '@shared/types'
import type { AdoPullRequest } from '@shared/prs'

// Azure DevOps REST client. Deliberately dependency-free and transport-free:
// every request goes through an injected `FetchLike`, which main binds to
// Electron's proxy-aware `net.fetch` and the unit tests bind to a fake. The
// class itself knows nothing about Electron, so ado.test.ts runs in plain node.
//
// Two rules matter more than the rest:
//   1. `api-version=6.0` (connectionData: `6.0-preview`) is the newest version
//      that on-prem Azure DevOps Server 2019 answers, and dev.azure.com still
//      accepts it. Do not bump it without checking both.
//   2. A rejected PAT does NOT come back as 401. Azure DevOps answers a browser
//      with an HTML sign-in page and status 203 (or a 200 carrying HTML), so a
//      non-JSON body is treated as `unauthorized` rather than a parse bug.
//
// The token is a secret with a long life: it must never reach a log line, a
// renderer payload or an `AdoError.detail`. Everything that becomes a detail
// goes through `redact()` first, belt and braces.

/** The structural subset of `Response` this client reads. */
export interface AdoResponse {
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<AdoResponse>

export interface AdoClientOpts {
  baseUrl: string
  token: string
  userAgent: string
  timeoutMs?: number
}

export interface AdoRepo {
  id: string
  name: string
  defaultBranch: string
}

const DEFAULT_TIMEOUT_MS = 15_000
/** Paging guard: 500 projects a page is already far past any real collection. */
const MAX_PAGES = 20
const MAX_DETAIL = 200
const API = '6.0'
const API_PREVIEW = '6.0-preview'

// ---------------------------------------------------------------------------
// Token hygiene

/**
 * Replaces the token (raw, base64-of-`:token` as it appears in the auth header,
 * and percent-encoded) with `***` anywhere it shows up. Short tokens are left
 * alone — a 3-character needle would shred unrelated text — but a real PAT is
 * 52 characters.
 */
function makeRedactor(token: string): (s: string) => string {
  const needles = new Set<string>()
  const add = (s: string): void => {
    if (s.length >= 8) needles.add(s)
  }
  if (typeof token === 'string' && token) {
    add(token)
    add(Buffer.from(`:${token}`, 'utf8').toString('base64'))
    add(Buffer.from(token, 'utf8').toString('base64'))
    add(encodeURIComponent(token))
  }
  return (s: string): string => {
    let out = s
    for (const n of needles) out = out.split(n).join('***')
    return out
  }
}

function tidy(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL - 1)}…` : flat
}

// ---------------------------------------------------------------------------
// Failure classification

/** Chromium surfaces network trouble as `ERR_*` inside the thrown message. */
function classifyThrown(err: unknown): AdoErrorCode {
  const name = typeof err === 'object' && err !== null ? String((err as { name?: unknown }).name ?? '') : ''
  const msg = err instanceof Error ? err.message : String(err)
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout'
  if (/ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|\baborted\b/i.test(msg)) return 'timeout'
  if (/ERR_CERT|ERR_SSL|ERR_BAD_SSL|CERT_|self[- ]signed certificate|UNABLE_TO_VERIFY/i.test(msg)) return 'tls'
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return 'dns'
  if (/ERR_PROXY_AUTH_REQUESTED/i.test(msg)) return 'proxy-auth'
  return 'network'
}

const SENTENCE: Record<AdoErrorCode, string> = {
  unauthorized: 'Azure DevOps rejected the token',
  forbidden: 'The token does not have access to this resource',
  'not-found': 'Azure DevOps returned 404 for this address',
  'proxy-auth': 'The proxy wants credentials',
  tls: "The server's certificate isn't trusted by this machine",
  dns: 'The server name could not be resolved',
  network: 'Could not reach the server',
  timeout: 'The request timed out',
  http: 'Azure DevOps returned an unexpected status',
  'bad-url': 'That is not a usable Azure DevOps collection URL',
}

// ---------------------------------------------------------------------------

interface Page {
  body: unknown
  continuation: string | null
}

export class AdoClient {
  private readonly base: string
  private readonly timeoutMs: number
  private readonly redact: (s: string) => string

  constructor(
    private fetchImpl: FetchLike,
    private opts: AdoClientOpts,
  ) {
    this.base = String(opts.baseUrl ?? '')
      .trim()
      .replace(/\/+$/, '')
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.redact = makeRedactor(opts.token)
  }

  // -------------------------------------------------------------------------
  // Endpoints

  /** `authenticatedUser` from connectionData — the cheapest "is this PAT good" probe. */
  async me(): Promise<AdoResult<{ id: string; name: string }>> {
    const page = await this.get('/_apis/connectionData', { 'api-version': API_PREVIEW })
    if (!page.ok) return page
    const user = (
      page.value.body as {
        authenticatedUser?: { id?: unknown; providerDisplayName?: unknown; descriptor?: unknown }
      } | null
    )?.authenticatedUser
    // An anonymous answer is a rejected PAT wearing a 200: no id, the all-zero
    // guid, or — on an organization with public projects — the all-`a` guid
    // with a `System:PublicAccess;…` descriptor (verified against
    // dev.azure.com/dnceng-public without any credentials).
    const id = typeof user?.id === 'string' ? user.id : ''
    const descriptor = typeof user?.descriptor === 'string' ? user.descriptor : ''
    if (!id || /^[0a]{8}-[0a]{4}-[0a]{4}-[0a]{4}-[0a]{12}$/.test(id) || descriptor.startsWith('System:PublicAccess')) {
      return this.fail('unauthorized', 'Azure DevOps answered without an authenticated user')
    }
    return { ok: true, value: { id, name: typeof user?.providerDisplayName === 'string' ? user.providerDisplayName : id } }
  }

  async projects(): Promise<AdoResult<{ id: string; name: string }[]>> {
    const out: { id: string; name: string }[] = []
    let continuation: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const params: Record<string, string> = { 'api-version': API, $top: '500' }
      if (continuation) params.continuationToken = continuation
      const res: AdoResult<Page> = await this.get('/_apis/projects', params)
      if (!res.ok) return res
      for (const p of listOf(res.value.body)) {
        const id = str(p.id)
        const name = str(p.name)
        if (id && name) out.push({ id, name })
      }
      continuation = res.value.continuation
      if (!continuation) break
    }
    return { ok: true, value: out }
  }

  async repos(project: string): Promise<AdoResult<AdoRepo[]>> {
    const res = await this.get(`/${encodeURIComponent(project)}/_apis/git/repositories`, { 'api-version': API })
    if (!res.ok) return res
    const out: AdoRepo[] = []
    for (const r of listOf(res.value.body)) {
      const id = str(r.id)
      const name = str(r.name)
      if (!id || !name) continue
      out.push({ id, name, defaultBranch: stripRef(str(r.defaultBranch)) })
    }
    return { ok: true, value: out }
  }

  async activePullRequests(project: string, repoId: string): Promise<AdoResult<AdoPullRequest[]>> {
    const res = await this.get(
      `/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repoId)}/pullrequests`,
      { 'searchCriteria.status': 'active', $top: '200', 'api-version': API },
    )
    if (!res.ok) return res
    const out: AdoPullRequest[] = []
    for (const raw of listOf(res.value.body)) {
      if (typeof raw.pullRequestId !== 'number') continue
      out.push(raw as unknown as AdoPullRequest)
    }
    return { ok: true, value: out }
  }

  // -------------------------------------------------------------------------
  // Transport

  private fail(code: AdoErrorCode, detail: string): { ok: false; error: AdoError } {
    return { ok: false, error: { code, detail: tidy(this.redact(detail)) } }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(`:${this.opts.token}`, 'utf8').toString('base64')}`,
      Accept: 'application/json',
      'User-Agent': this.opts.userAgent,
    }
  }

  private url(path: string, params: Record<string, string>): string {
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&')
    return `${this.base}${path}${qs ? `?${qs}` : ''}`
  }

  private async get(path: string, params: Record<string, string>): Promise<AdoResult<Page>> {
    if (!/^https?:\/\/[^/]+/i.test(this.base)) {
      return this.fail('bad-url', `${SENTENCE['bad-url']}: ${this.base || '(empty)'}`)
    }

    let res: AdoResponse
    try {
      res = await this.fetchImpl(this.url(path, params), {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (err) {
      const code = classifyThrown(err)
      return this.fail(code, `${SENTENCE[code]} (${err instanceof Error ? err.message : String(err)})`)
    }

    let text: string
    try {
      text = await res.text()
    } catch (err) {
      const code = classifyThrown(err)
      return this.fail(code, `${SENTENCE[code]} while reading the response`)
    }

    switch (res.status) {
      case 401:
        return this.fail('unauthorized', SENTENCE.unauthorized)
      case 403:
        return this.fail('forbidden', SENTENCE.forbidden)
      case 404:
        return this.fail('not-found', `${SENTENCE['not-found']}: ${path}`)
      case 407:
        return this.fail('proxy-auth', SENTENCE['proxy-auth'])
      case 203:
        // The sign-in page. This is what a bad or expired PAT actually looks like.
        return this.fail('unauthorized', `${SENTENCE.unauthorized} (sign-in page returned)`)
      default:
        break
    }
    if (res.status >= 300 && res.status < 400) {
      // A redirect the transport did not follow. Azure DevOps sends unauthenticated
      // API calls to `…vssps.visualstudio.com/_signin` (curl sees this where a
      // browser-shaped client sees 203) — that is a rejected token, not a
      // mystery status.
      const location = res.headers.get('location') ?? ''
      if (/_signin|login\.microsoftonline\.com/i.test(location)) {
        return this.fail('unauthorized', `${SENTENCE.unauthorized} (redirected to sign in)`)
      }
      return this.fail('http', `${SENTENCE.http}: HTTP ${res.status} redirect to ${location || '(no location)'}`)
    }
    if (res.status < 200 || res.status >= 300) {
      return this.fail('http', `${SENTENCE.http}: HTTP ${res.status} ${text.slice(0, MAX_DETAIL)}`)
    }

    let body: unknown
    try {
      body = JSON.parse(text) as unknown
    } catch {
      // 200 + HTML: same sign-in page, different status.
      return this.fail('unauthorized', `${SENTENCE.unauthorized} (the server answered with a page, not JSON)`)
    }
    if (body === null || typeof body !== 'object') {
      return this.fail('unauthorized', `${SENTENCE.unauthorized} (the server answered with a page, not JSON)`)
    }

    return {
      ok: true,
      value: { body, continuation: res.headers.get('x-ms-continuationtoken') || null },
    }
  }
}

// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function stripRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

/** `{ count, value: [...] }` is the shape of every ADO list response. */
function listOf(body: unknown): Record<string, unknown>[] {
  const v = (body as { value?: unknown } | null)?.value
  if (!Array.isArray(v)) return []
  return v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
}
