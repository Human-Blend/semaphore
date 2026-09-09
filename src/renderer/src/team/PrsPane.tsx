import { useEffect, useMemo, useRef, useState } from 'react'
import type { AdoError, AdoErrorCode, PrView } from '@shared/types'
import { useStore } from '@/store'
import { Avatar, Button, IconButton, Spinner } from '@/ui/atoms'
import { IconExternal, IconGear, IconGitPull, IconRefresh, IconWarn } from '@/app/icons'
import { truncate } from '@/app/chrome'
import { toast } from '@/app/toasts'
import { PrsPrefs } from './PrsPrefs'

// Spec §2.7 — the pull-request pane. Owns the whole centre column (no channel
// header, no right rail). Everything it shows comes from the main-side PR
// service via the store (`prs`, `prsStatus`); the only writes are refresh,
// markSeen, setPersonalToken and the prefs modal's saveConfig.

// ---------------------------------------------------------------------------
// Small local helpers

/** Compact "how long ago" — just now, 12m, 3h, 6d, 2mo, 1y. */
export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo}mo`
  return `${Math.round(d / 365)}y`
}

/** "3d ago" / "just now" / "unknown" — never "56y ago" for a missing date. */
function agoPhrase(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown'
  const t = timeAgo(ms)
  return t === 'just now' ? t : `${t} ago`
}

/**
 * One honest sentence per failure mode. The pane never shows a raw HTTP body;
 * `detail` is redacted main-side, so it rides along as the tooltip.
 */
const ERROR_SENTENCE: Record<AdoErrorCode, string> = {
  unauthorized: 'Azure DevOps rejected the token — it may have expired.',
  forbidden: "The token works, but it isn't allowed to read this project.",
  'not-found': 'Nothing at that address — check the organization, collection or project name.',
  'proxy-auth': 'The proxy wants credentials before it will let this machine through.',
  tls: "The server's certificate isn't trusted by this machine.",
  dns: "That host name doesn't resolve — check the URL, or the VPN.",
  network: "Couldn't reach Azure DevOps — the network or the VPN is in the way.",
  timeout: 'Azure DevOps took too long to answer.',
  http: 'Azure DevOps answered with an error.',
  'bad-url': "That doesn't look like an Azure DevOps collection URL.",
  'api-version': 'This Azure DevOps server is too old for Chat — it speaks none of the API versions Chat can.',
}

export function errorSentence(e: AdoError): string {
  return ERROR_SENTENCE[e.code] ?? 'Azure DevOps could not be reached.'
}

/** Vote → ring colour. ADO: 10/5 approved, 0 no vote, -5/-10 blocking. */
function voteColor(vote: number): string {
  if (vote >= 5) return 'var(--success)'
  if (vote < 0) return 'var(--danger)'
  return 'var(--border-strong)'
}

function voteWord(vote: number): string {
  if (vote >= 10) return 'approved'
  if (vote >= 5) return 'approved with suggestions'
  if (vote <= -10) return 'rejected'
  if (vote < 0) return 'waiting for the author'
  return 'no vote yet'
}

type Scope = 'all' | 'assigned' | 'mine'

// ---------------------------------------------------------------------------
// Pieces

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { v: T; label: string }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{
        display: 'inline-flex',
        gap: 2,
        padding: 2,
        background: 'var(--bg-input)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--r-sm)',
        flexShrink: 0,
      }}
    >
      {options.map((o) => (
        <button
          key={o.v}
          role="radio"
          aria-checked={value === o.v}
          title={o.label}
          className="sem-focus"
          onClick={() => onChange(o.v)}
          style={{
            height: 24,
            padding: '0 10px',
            border: 'none',
            borderRadius: 'var(--r-xs)',
            fontSize: 12,
            fontWeight: value === o.v ? 600 : 400,
            fontFamily: 'var(--font-ui)',
            color: value === o.v ? 'var(--text-1)' : 'var(--text-3)',
            background: value === o.v ? 'var(--bg-raised)' : 'transparent',
            cursor: 'pointer',
            transition: 'background var(--t-fast) var(--ease-standard), color var(--t-fast) var(--ease-standard)',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function ReviewerPip({ name, vote, required }: { name: string; vote: number; required: boolean }) {
  const ring = voteColor(vote)
  return (
    <span
      title={`${name} — ${voteWord(vote)}${required ? ' (required reviewer)' : ''}`}
      aria-label={`${name}, ${voteWord(vote)}${required ? ', required reviewer' : ''}`}
      style={{
        display: 'inline-flex',
        borderRadius: 'var(--r-md)',
        boxShadow: required ? `0 0 0 2px ${ring}` : `0 0 0 1.5px color-mix(in srgb, ${ring} 45%, transparent)`,
      }}
    >
      <Avatar name={name || '?'} size={22} />
    </span>
  )
}

/**
 * `asName` is set only when this machine polls with the team's shared token: the
 * "me" every me-relative flag is computed against is that token's owner, not the
 * person reading the pane, so the chip has to say whose review is missing.
 */
function AwaitingChip({ asName }: { asName?: string | null }) {
  return (
    <span
      title={
        asName
          ? `${asName} is a reviewer and hasn't voted yet — the team shares one Azure DevOps token, ` +
            `so this answers for ${asName}, not for you`
          : "You are a reviewer and haven't voted yet"
      }
      style={{
        height: 18,
        padding: '0 7px',
        borderRadius: 'var(--r-full)',
        background: 'var(--danger-soft)',
        color: 'var(--danger)',
        border: '1px solid color-mix(in srgb, var(--danger) 40%, transparent)',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.02em',
        display: 'inline-flex',
        alignItems: 'center',
        flexShrink: 0,
        whiteSpace: 'nowrap',
      }}
    >
      {asName ? `awaiting ${asName}` : 'awaiting you'}
    </span>
  )
}

/** First name only — the chip and the segments sit in a tight row. */
function shortName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? ''
  return first.length > 14 ? `${first.slice(0, 13)}…` : first
}

function PrRow({ pr, asName }: { pr: PrView; asName: string | null }) {
  const [hover, setHover] = useState(false)
  const open = () => {
    void window.bridge.app.openExternal(pr.webUrl).catch(() => toast('Could not open the browser', 'danger'))
  }
  const shown = pr.reviewers.slice(0, 4)
  const extra = pr.reviewers.length - shown.length

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(false)
      }}
      className="sem-focus"
      title={`${pr.title} — open #${pr.id} in the browser`}
      aria-label={`Pull request ${pr.id}, ${pr.title}, in ${pr.repoName} by ${pr.author.name}${
        pr.seen ? '' : ', unseen'
      }`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        minHeight: 56,
        padding: '8px 12px 8px 8px',
        borderRadius: 'var(--r-md)',
        border: '1px solid var(--border-subtle)',
        background: hover ? 'var(--bg-raised)' : 'var(--bg-panel)',
        cursor: 'pointer',
        transition: 'background var(--t-fast) var(--ease-standard)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          flexShrink: 0,
          background: pr.seen ? 'transparent' : 'var(--danger)',
        }}
      />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-3)', flexShrink: 0 }}>
            #{pr.id}
          </span>
          <span
            style={{
              ...truncate,
              minWidth: 0,
              fontSize: 13,
              fontWeight: pr.seen ? 400 : 600,
              color: 'var(--text-1)',
            }}
          >
            {pr.title}
          </span>
          {pr.assignedToMe && pr.myVote === 0 && <AwaitingChip asName={asName} />}
        </div>
        <div style={{ ...truncate, marginTop: 3, fontSize: 11, color: 'var(--text-3)' }}>
          {pr.repoName} · {pr.author.name || 'unknown author'} · {pr.sourceBranch} → {pr.targetBranch} · created{' '}
          {agoPhrase(pr.createdAt)}
        </div>
      </div>

      {hover && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <button
            className="sem-chip-btn sem-focus"
            title="Copy the pull request link"
            aria-label={`Copy the link to pull request ${pr.id}`}
            onClick={(e) => {
              e.stopPropagation()
              void window.bridge.app
                .copyText(pr.webUrl)
                .then(() => toast('Link copied', 'success'))
                .catch(() => toast('Could not copy the link', 'danger'))
            }}
            style={{ height: 24, padding: '0 10px', fontSize: 11 }}
          >
            Copy link
          </button>
          <button
            className="sem-chip-btn sem-focus"
            title="Open in the browser"
            aria-label={`Open pull request ${pr.id} in the browser`}
            onClick={(e) => {
              e.stopPropagation()
              open()
            }}
            style={{ height: 24, padding: '0 10px', fontSize: 11 }}
          >
            <IconExternal size={12} />
            Open
          </button>
        </span>
      )}

      <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        {shown.map((r) => (
          <ReviewerPip key={r.id || r.name} name={r.name} vote={r.vote} required={r.required} />
        ))}
        {extra > 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-3)' }} title={`${extra} more reviewer${extra === 1 ? '' : 's'}`}>
            +{extra}
          </span>
        )}
      </span>
    </div>
  )
}

function ErrorStrip({ error, onRetry }: { error: AdoError; onRetry: () => void }) {
  return (
    <div
      role="alert"
      title={error.detail || undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 40,
        flexShrink: 0,
        padding: '8px 16px',
        fontSize: 13,
        color: 'var(--danger)',
        background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
        borderBottom: '1px solid var(--border-subtle)',
        animation: 'sem-banner-in var(--t-base) var(--ease-standard)',
      }}
    >
      <IconWarn size={15} />
      <span style={{ color: 'var(--text-1)', flex: 1, minWidth: 0 }}>{errorSentence(error)}</span>
      <button className="sem-chip-btn sem-focus" onClick={onRetry} title="Try Azure DevOps again" aria-label="Retry">
        Retry
      </button>
    </div>
  )
}

/** Nobody on the team has connected Azure DevOps yet. */
function SetupCard({ onConnect }: { onConnect: () => void }) {
  return (
    <div
      style={{
        margin: 'auto',
        maxWidth: 460,
        padding: 24,
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        animation: 'sem-fade var(--t-slow) var(--ease-standard)',
      }}
    >
      <span style={{ color: 'var(--text-3)' }}>
        <IconGitPull size={44} />
      </span>
      <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-1)' }}>Watch your team's pull requests</div>
      <div style={{ fontSize: 13, color: 'var(--text-3)', lineHeight: '19px' }}>
        Connect an Azure DevOps project and Chat keeps a live list of the pull requests that still need review — with a
        red badge when a new one shows up. The repositories you pick are shared with the whole team, and anyone can set
        this up.
      </div>
      <Button onClick={onConnect}>Connect Azure DevOps</Button>
    </div>
  )
}

/** Configured by someone else, but this machine has no token of its own. */
function TokenCard({ baseUrl }: { baseUrl: string }) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    const t = token.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      await window.bridge.prs.setPersonalToken(t)
      setToken('') // never keep the secret in the DOM after it is stored
      await window.bridge.prs.refresh()
    } catch {
      toast('Could not store that token', 'danger')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      style={{
        margin: 'auto',
        maxWidth: 440,
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        animation: 'sem-fade var(--t-slow) var(--ease-standard)',
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-1)' }}>Enter your Azure DevOps token</div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: '17px' }}>
        The project is already set up for the team, but whoever configured it chose not to share their token. Create a
        personal access token with scope <b>Code → Read</b> — it stays encrypted on this machine and is never written to
        the shared folder. SSH keys only work for Git, not for the REST API.
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
        style={{ display: 'flex', gap: 8, alignItems: 'center' }}
      >
        <input
          className="sem-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Personal access token"
          aria-label="Azure DevOps personal access token"
          title="Azure DevOps personal access token"
          style={{ flex: 1 }}
        />
        <Button type="submit" disabled={busy || token.trim() === ''}>
          {busy ? <Spinner size={13} /> : 'Save'}
        </Button>
      </form>
      {baseUrl !== '' && (
        <button
          className="sem-focus"
          onClick={() => void window.bridge.app.openExternal(`${baseUrl}/_usersSettings/tokens`).catch(() => {})}
          title={`${baseUrl}/_usersSettings/tokens`}
          aria-label="Open the Azure DevOps token page"
          style={{
            alignSelf: 'flex-start',
            border: 'none',
            background: 'transparent',
            padding: 0,
            color: 'var(--accent-text)',
            fontSize: 12,
            fontFamily: 'var(--font-ui)',
            cursor: 'pointer',
          }}
        >
          Create a token in Azure DevOps →
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The pane

export function PrsPane() {
  const prs = useStore((s) => s.prs)
  const status = useStore((s) => s.prsStatus)

  // Lives in the store so the sidebar row's gear / context menu can open it too.
  const prefsOpen = useStore((s) => s.prsPrefsOpen)
  const setPrefsOpen = useStore((s) => s.setPrsPrefsOpen)
  const [scope, setScope] = useState<Scope>('all')
  const [branch, setBranch] = useState('')
  const [repoId, setRepoId] = useState('')
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const meId = status?.me?.id ?? null
  const repos = useMemo(() => status?.repos ?? [], [status])

  // On the team's shared token the polled identity is the configurer's account,
  // not the reader's — so every me-relative label ("assigned to me", "mine",
  // "awaiting you") is answering for someone else. Name them instead of
  // pretending the answer is about you.
  const sharedAs = status && status.tokenSource === 'shared' && status.me ? shortName(status.me.name) : null
  const sharedTitle = sharedAs
    ? `Signed in to Azure DevOps as ${status?.me?.name ?? sharedAs}. The team is sharing one token, so ` +
      `"assigned" and "awaiting" answer for ${sharedAs}, not for you — stop sharing the token in the ` +
      `settings and everyone enters their own.`
    : undefined

  // Filters belong to one configuration: when the group is pointed at another
  // project or another repo set, a stale branch/repo filter would silently hide
  // everything. Reset them on any config change.
  const configKey = status ? `${status.baseUrl}|${status.project}|${repos.map((r) => r.id).join(',')}` : ''
  useEffect(() => {
    setScope('all')
    setBranch('')
    setRepoId('')
    setQuery('')
  }, [configKey])

  const branches = useMemo(() => {
    const set = new Set<string>()
    for (const p of prs) if (p.targetBranch) set.add(p.targetBranch)
    return [...set].sort()
  }, [prs])

  // A branch that no longer exists in the list would filter everything away.
  useEffect(() => {
    if (branch !== '' && !branches.includes(branch)) setBranch('')
  }, [branch, branches])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return prs
      .filter((p) => {
        if (scope === 'assigned' && !p.assignedToMe) return false
        if (scope === 'mine' && (!meId || p.author.id !== meId)) return false
        if (branch !== '' && p.targetBranch !== branch) return false
        if (repoId !== '' && p.repoId !== repoId) return false
        if (q !== '') {
          const hay = `${p.title} ${p.author.name} ${p.sourceBranch} ${p.targetBranch} ${p.repoName} #${p.id}`
          if (!hay.toLowerCase().includes(q)) return false
        }
        return true
      })
      .sort((a, b) => b.createdAt - a.createdAt || (a.key < b.key ? -1 : 1))
  }, [prs, scope, branch, repoId, query, meId])

  // Seen marking (spec §2.7): only while this machine actually has the window,
  // and only after a 1.5s dwell — opening the pane by accident must not clear
  // the team's red badge. The keys string is the dependency, so a push that
  // merely flips `seen` does not re-arm the timer.
  const visibleKeys = useMemo(() => filtered.map((p) => p.key).join(' '), [filtered])
  const timerRef = useRef<number | null>(null)
  useEffect(() => {
    if (visibleKeys === '') return undefined
    const arm = (): void => {
      if (!document.hasFocus() || timerRef.current !== null) return
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        if (!document.hasFocus()) return
        void window.bridge.prs.markSeen(visibleKeys.split(' ')).catch(() => {})
      }, 1500)
    }
    arm()
    window.addEventListener('focus', arm)
    return () => {
      window.removeEventListener('focus', arm)
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [visibleKeys])

  async function refresh() {
    if (refreshing) return
    setRefreshing(true)
    try {
      await window.bridge.prs.refresh()
    } catch {
      toast('Could not reach the pull-request service', 'danger')
    } finally {
      setRefreshing(false)
    }
  }

  const spinning = refreshing || status?.polling === true
  const configured = status?.configured === true
  const needsToken = configured && status?.tokenSource === 'none'

  const repoLabel = repos.length === 1 ? repos[0].name : `${repos.length} repositories`
  const subtitle = !status ? '' : !configured ? 'Not connected yet' : `${repoLabel} · ${status.project || 'project'}`

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-app)' }}>
      <div
        style={{
          height: 52,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 12px 0 16px',
          borderBottom: '1px solid var(--border-subtle)',
          minWidth: 0,
        }}
      >
        <span aria-hidden="true" style={{ color: 'var(--text-3)', display: 'flex' }}>
          <IconGitPull size={18} />
        </span>
        <span style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-1)', whiteSpace: 'nowrap' }}>
          Pull requests
        </span>
        {configured && (
          <span
            title={`${filtered.length} shown of ${prs.length} tracked`}
            style={{
              minWidth: 20,
              height: 18,
              padding: '0 6px',
              borderRadius: 'var(--r-full)',
              background: 'var(--bg-raised)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-2)',
              fontSize: 11,
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {filtered.length}
          </span>
        )}
        <span
          title={status ? `${status.baseUrl}${status.project ? ` · ${status.project}` : ''}` : undefined}
          style={{
            ...truncate,
            flex: 1,
            minWidth: 0,
            fontSize: 13,
            color: 'var(--text-3)',
            borderLeft: '1px solid var(--border-subtle)',
            paddingLeft: 10,
          }}
        >
          {subtitle}
        </span>
        {sharedAs && (
          <span
            title={sharedTitle}
            style={{
              height: 18,
              padding: '0 7px',
              borderRadius: 'var(--r-full)',
              background: 'var(--bg-raised)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-2)',
              fontSize: 11,
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
          >
            as {sharedAs}
          </span>
        )}
        <span style={{ fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
          {status?.lastPollAt ? `checked ${agoPhrase(status.lastPollAt)}` : ''}
        </span>
        <IconButton label="Check Azure DevOps now" onClick={() => void refresh()}>
          <span style={{ display: 'flex', animation: spinning ? 'sem-spin 0.9s linear infinite' : undefined }}>
            <IconRefresh size={16} />
          </span>
        </IconButton>
        <IconButton label="Pull request settings" active={prefsOpen} onClick={() => setPrefsOpen(true)}>
          <IconGear size={16} />
        </IconButton>
      </div>

      {configured && (
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 16px',
            borderBottom: '1px solid var(--border-subtle)',
            flexWrap: 'wrap',
          }}
        >
          <Segmented
            label="Which pull requests"
            value={scope}
            options={[
              { v: 'all' as const, label: 'All' },
              { v: 'assigned' as const, label: sharedAs ? `Assigned to ${sharedAs}` : 'Assigned to me' },
              { v: 'mine' as const, label: sharedAs ? `By ${sharedAs}` : 'Mine' },
            ]}
            onChange={setScope}
          />
          <select
            className="sem-input sem-focus"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            aria-label="Filter by target branch"
            title="Filter by target branch"
            style={{ width: 'auto', maxWidth: 200, height: 28, cursor: 'pointer' }}
          >
            <option value="">Any branch</option>
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          {repos.length > 1 && (
            <select
              className="sem-input sem-focus"
              value={repoId}
              onChange={(e) => setRepoId(e.target.value)}
              aria-label="Filter by repository"
              title="Filter by repository"
              style={{ width: 'auto', maxWidth: 200, height: 28, cursor: 'pointer' }}
            >
              <option value="">All repositories</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
          <input
            className="sem-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title, author or branch"
            aria-label="Search pull requests"
            title="Search pull requests"
            style={{ flex: 1, minWidth: 160, height: 28 }}
          />
        </div>
      )}

      {status?.error && <ErrorStrip error={status.error} onRetry={() => void refresh()} />}

      <div className="sem-scroll" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {!status ? (
          <div style={{ margin: 'auto', display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-3)' }}>
            <Spinner /> <span style={{ fontSize: 13 }}>Loading pull requests…</span>
          </div>
        ) : !configured ? (
          <SetupCard onConnect={() => setPrefsOpen(true)} />
        ) : needsToken ? (
          <TokenCard baseUrl={status.baseUrl} />
        ) : filtered.length === 0 ? (
          <div
            style={{
              margin: 'auto',
              textAlign: 'center',
              color: 'var(--text-3)',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              animation: 'sem-fade var(--t-slow) var(--ease-standard)',
            }}
          >
            <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-1)' }}>
              {prs.length === 0 ? 'Nothing waiting for review 🎉' : 'Nothing matches these filters'}
            </div>
            <div style={{ fontSize: 13 }}>
              {prs.length === 0
                ? 'Approved, completed and draft pull requests drop off this list automatically.'
                : `${prs.length} pull request${prs.length === 1 ? ' is' : 's are'} hidden by the filters above.`}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 16px 16px' }}>
            {filtered.map((p) => (
              <PrRow key={p.key} pr={p} asName={sharedAs} />
            ))}
          </div>
        )}
      </div>

      {prefsOpen && <PrsPrefs onClose={() => setPrefsOpen(false)} />}
    </div>
  )
}
