import type { PushMessage } from './bridge'
import type { PrView, PrsConfig, PrsPayload, PrsRepo, VerifiedEvent } from './types'

// Pure helpers for the pull-request group: the shape of the Azure DevOps JSON
// we consume, the approval/tracking rules, and the LWW merge of the
// 'team:prs' config log. No I/O — the network lives in main/services/ado.ts.

/**
 * The subset of an Azure DevOps 6.0 pull request that this app reads. Anything
 * else in the response is ignored; `isRequired` is absent on some on-prem
 * servers, which reads as "not required".
 */
export interface AdoPullRequest {
  pullRequestId: number
  title: string
  status: string // 'active' | 'completed' | 'abandoned' | …
  isDraft: boolean
  createdBy: { id: string; displayName: string }
  creationDate: string // ISO 8601
  sourceRefName: string // 'refs/heads/feature/x'
  targetRefName: string // 'refs/heads/main'
  repository: { id: string; name: string }
  reviewers: { id: string; displayName: string; vote: number; isRequired?: boolean }[]
}

const REF_PREFIX = 'refs/heads/'

function stripRef(ref: string): string {
  return typeof ref === 'string' && ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : (ref ?? '')
}

// ---------------------------------------------------------------------------
// Approval / tracking rules

/**
 * ADO votes: 10 approved, 5 approved-with-suggestions, 0 no vote,
 * -5 waiting for author, -10 rejected. A PR counts as approved when somebody
 * actually approved it, nobody is blocking, and every required reviewer signed
 * off — so a required reviewer sitting at 0 keeps it in the list.
 */
export function isApproved(reviewers: PrView['reviewers']): boolean {
  if (!Array.isArray(reviewers) || reviewers.length === 0) return false
  let anyApproval = false
  for (const r of reviewers) {
    const vote = typeof r.vote === 'number' ? r.vote : 0
    if (vote < 0) return false
    if (vote >= 5) anyApproval = true
    else if (r.required) return false
  }
  return anyApproval
}

/** A PR is worth showing while it is open, not a draft, and not yet approved. */
export function isTracked(pr: { isDraft: boolean; status: string; reviewers: PrView['reviewers'] }): boolean {
  return pr.status === 'active' && !pr.isDraft && !isApproved(pr.reviewers)
}

// ---------------------------------------------------------------------------
// View projection

export function toPrView(
  raw: AdoPullRequest,
  ctx: { baseUrl: string; project: string; meId: string | null; seen: Set<string> },
): PrView {
  const repoId = raw.repository?.id ?? ''
  const repoName = raw.repository?.name ?? ''
  const id = raw.pullRequestId
  const key = `${repoId}:${id}`
  const reviewers = (raw.reviewers ?? []).map((r) => ({
    id: r.id,
    name: r.displayName,
    vote: typeof r.vote === 'number' ? r.vote : 0,
    required: r.isRequired === true,
  }))
  const mine = ctx.meId ? reviewers.find((r) => r.id === ctx.meId) : undefined
  const createdAt = Date.parse(raw.creationDate)

  return {
    key,
    id,
    title: raw.title ?? '',
    repoId,
    repoName,
    author: { id: raw.createdBy?.id ?? '', name: raw.createdBy?.displayName ?? '' },
    sourceBranch: stripRef(raw.sourceRefName),
    targetBranch: stripRef(raw.targetRefName),
    createdAt: Number.isNaN(createdAt) ? 0 : createdAt,
    isDraft: raw.isDraft === true,
    reviewers,
    assignedToMe: mine !== undefined,
    myVote: mine ? mine.vote : 0,
    webUrl: `${ctx.baseUrl}/${encodeURIComponent(ctx.project)}/_git/${encodeURIComponent(repoName)}/pullrequest/${id}`,
    seen: ctx.seen.has(key),
  }
}

// ---------------------------------------------------------------------------
// Config log

function validRepos(v: unknown): v is PrsRepo[] {
  if (!Array.isArray(v)) return false
  return v.every(
    (r) =>
      !!r && typeof r === 'object' && typeof (r as PrsRepo).id === 'string' && typeof (r as PrsRepo).name === 'string',
  )
}

function validConfig(v: unknown): v is PrsConfig {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return (
    typeof c.baseUrl === 'string' &&
    typeof c.project === 'string' &&
    typeof c.sharedToken === 'string' &&
    validRepos(c.repos)
  )
}

/**
 * Last valid 'prs' snapshot in stem order wins (the payload is a full config,
 * never a patch). Unverified events are ignored; null means nobody has ever
 * configured the group.
 */
export function materializePrsConfig(events: VerifiedEvent[]): { config: PrsConfig; by: string; id: string } | null {
  const sorted = [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  let winner: { config: PrsConfig; by: string; id: string } | null = null

  for (const ev of sorted) {
    if (!ev.verified) continue
    const p = ev.payload as PrsPayload
    if (!p || p.t !== 'prs') continue
    if (!validConfig(p.config)) continue
    // A config off the share is as untrusted as renderer input — it decides
    // which host every teammate's token is sent to — so its base URL goes
    // through the same normalizer. '' is the disconnect snapshot; anything
    // that does not normalize is dropped and the previous winner stands.
    const baseUrl = p.config.baseUrl === '' ? '' : normalizeBaseUrl(p.config.baseUrl)
    if (baseUrl === null) continue
    winner = {
      config: {
        baseUrl,
        project: p.config.project,
        repos: p.config.repos.map((r) => ({ id: r.id, name: r.name })),
        sharedToken: p.config.sharedToken,
      },
      by: ev.author,
      id: ev.id,
    }
  }

  return winner
}

/**
 * A `team:prs` event as the renderer may see it. The config lives in a shared
 * log, so the raw payload carries the team's Azure DevOps PAT — a credential
 * for a system outside this app, and one `PrsStatus` deliberately narrows to
 * `sharedTokenSet: boolean`. Nothing in the renderer reads it, so it is
 * stripped at the bridge rather than copied into sandboxed web memory.
 *
 * Main-side readers (PrService materializing the config) must not go through
 * this — they need the token to poll.
 */
export function redactEventForRenderer(ev: VerifiedEvent): VerifiedEvent {
  const p = ev.payload as PrsPayload
  if (!p || p.t !== 'prs' || !validConfig(p.config) || p.config.sharedToken === '') return ev
  return { ...ev, payload: { ...p, config: { ...p.config, sharedToken: '' } } }
}

/**
 * The same strip, applied to the live `event` push — the other way a raw event
 * reaches the renderer (`chat:events` is the first). Every other push kind is
 * returned untouched and identical, so this is safe to put on the whole channel.
 */
export function redactPushForRenderer(msg: PushMessage): PushMessage {
  if (msg.kind !== 'event') return msg
  const event = redactEventForRenderer(msg.event)
  return event === msg.event ? msg : { ...msg, event }
}

function parseBaseUrl(input: string): URL | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed) return null
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username !== '' || u.password !== '') return null
  if (!u.host) return null
  return u
}

/**
 * Canonical form of a collection/organization URL: trimmed, no trailing slash,
 * no query/fragment, http(s) only, and never carrying credentials (a
 * `user:pass@` URL would put a secret into every log line and share write).
 */
export function normalizeBaseUrl(input: string): string | null {
  const u = parseBaseUrl(input)
  if (!u) return null
  const path = u.pathname.replace(/\/+$/, '')
  return `${u.protocol}//${u.host}${path}`
}

/**
 * Just the `protocol//host` of a base URL — the boundary that matters for a
 * credential. A personal token is entered for one server and must never be
 * sent to another, whatever collection path a later config carries.
 */
export function baseUrlOrigin(input: string): string | null {
  const u = parseBaseUrl(input)
  return u ? `${u.protocol}//${u.host}` : null
}
