import { useEffect, useRef, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import type { OnboardHealth } from '@shared/bridge'
import { Avatar, DeviceChip, Spinner, formatTime } from '@/ui/atoms'
import { IconCheck, IconFolder, IconLock, IconWarn, IconX } from '@/app/icons'
import { truncate } from '@/app/chrome'

// The four onboarding steps (spec §2.5). Pure presentational pieces — all
// state lives in Onboarding.tsx.

// ---------------------------------------------------------------------------
// Shared bits

export function StepTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 28, fontWeight: 700, lineHeight: '34px', color: 'var(--text-1)' }}>{children}</div>
      {sub && <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 8, lineHeight: '19px' }}>{sub}</div>}
    </div>
  )
}

export function DangerText({ children }: { children: ReactNode }) {
  return (
    <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--danger)', marginTop: 8 }}>
      <IconWarn size={13} />
      <span>{children}</span>
    </div>
  )
}

function CheckRow({ state, delay, children }: { state: 'ok' | 'fail'; delay: number; children: ReactNode }) {
  const [shown, setShown] = useState(delay === 0)
  useEffect(() => {
    if (delay === 0) return undefined
    const t = window.setTimeout(() => setShown(true), delay)
    return () => window.clearTimeout(t)
  }, [delay])
  if (!shown) return <div style={{ height: 24 }} />
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 24,
        fontSize: 13,
        color: state === 'ok' ? 'var(--text-1)' : 'var(--danger)',
        animation: 'sem-pop var(--t-fast) var(--ease-pop)',
      }}
    >
      <span style={{ color: state === 'ok' ? 'var(--success)' : 'var(--danger)', display: 'inline-flex' }}>
        {state === 'ok' ? <IconCheck size={15} /> : <IconX size={15} />}
      </span>
      {children}
    </div>
  )
}

function latencyGrade(ms: number): { color: string; text: string; state: 'ok' | 'fail' } {
  if (ms < 60) return { color: 'var(--success)', text: `Latency ${ms}ms — good`, state: 'ok' }
  if (ms < 150) return { color: 'var(--warning)', text: `Latency ${ms}ms — okay, expect slight delays`, state: 'ok' }
  return { color: 'var(--danger)', text: `Latency ${ms}ms — Chat will work, but slowly`, state: 'ok' }
}

// ---------------------------------------------------------------------------
// Step 1 — folder

export function StepFolder({
  suggestion,
  sharePath,
  health,
  checking,
  error,
  onChoose,
  onPick,
}: {
  suggestion: string | null
  sharePath: string | null
  health: OnboardHealth | null
  checking: boolean
  error: string | null
  onChoose: (path: string) => void
  onPick: () => void
}) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)

  function onDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault()
    depth.current = 0
    setOver(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    onChoose(window.bridge.files.pathForFile(file))
  }

  const grade = health ? latencyGrade(health.latencyMs) : null

  return (
    <div>
      <StepTitle sub="Chat has no server — your team lives in a shared folder everyone can reach. Teammates who pick this same folder all land in the same team: that's the whole trick.">
        Choose your team folder
      </StepTitle>

      <div
        role="button"
        tabIndex={0}
        aria-label="Choose your team folder — click to browse or drop a folder here"
        title="Click to browse, or drop a folder"
        className="sem-focus"
        onClick={onPick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onPick()
        }}
        onDragEnter={(e) => {
          e.preventDefault()
          depth.current += 1
          setOver(true)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1)
          if (depth.current === 0) setOver(false)
        }}
        onDrop={onDrop}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          padding: '24px 16px',
          borderRadius: 'var(--r-lg)',
          border: `1.5px dashed ${over ? 'var(--accent)' : 'var(--border-strong)'}`,
          background: over ? 'var(--accent-soft)' : 'var(--bg-input)',
          cursor: 'pointer',
          transition: 'border-color var(--t-fast) var(--ease-standard), background var(--t-fast) var(--ease-standard)',
        }}
      >
        <span style={{ color: over ? 'var(--accent-text)' : 'var(--text-3)' }}>
          <IconFolder size={28} />
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>
          {over ? 'Drop it here' : 'Drag your team folder here'}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>or click to browse</span>
      </div>

      {!sharePath && suggestion && (
        <button
          className="sem-chip-btn"
          onClick={() => onChoose(suggestion)}
          title={suggestion}
          style={{ marginTop: 10, maxWidth: '100%' }}
        >
          <span style={{ ...truncate, maxWidth: 380 }}>Use {suggestion}</span>
        </button>
      )}

      {sharePath && (
        <div style={{ marginTop: 14 }}>
          <div
            title={sharePath}
            style={{
              ...truncate,
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--text-2)',
              marginBottom: 8,
              userSelect: 'text',
            }}
          >
            {sharePath}
          </div>

          {checking && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-3)' }}>
              <Spinner size={14} /> Checking the folder…
            </div>
          )}

          {error && <DangerText>{error}</DangerText>}

          {health && !checking && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <CheckRow state={health.writable ? 'ok' : 'fail'} delay={0}>
                {health.writable ? 'Writable' : 'Write test failed — pick a folder you can write to'}
              </CheckRow>
              <CheckRow state={health.readBack ? 'ok' : 'fail'} delay={220}>
                {health.readBack ? 'Read-back OK' : 'Read-back failed — files written here can’t be read again'}
              </CheckRow>
              {grade && (
                <CheckRow state="ok" delay={440}>
                  <span style={{ color: grade.color }}>{grade.text}</span>
                </CheckRow>
              )}
              {health.writable && health.readBack && (
                <div
                  style={{
                    marginTop: 10,
                    padding: '8px 12px',
                    borderRadius: 'var(--r-md)',
                    background: 'var(--accent-soft)',
                    fontSize: 13,
                    color: 'var(--text-1)',
                    animation: 'sem-rise var(--t-base) var(--ease-standard)',
                  }}
                >
                  {health.existingTeamName ? (
                    <>
                      Found an existing team here — you’ll join <strong>{health.existingTeamName}</strong>.
                    </>
                  ) : (
                    <>This folder is empty — you’ll create a new team.</>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 2 — passphrase

function strengthOf(p: string): number {
  let s = 0
  if (p.length >= 8) s++
  if (p.length >= 12) s++
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++
  if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) s++
  return s
}

const STRENGTH_LABEL = ['too short', 'weak', 'okay', 'good', 'strong']
const STRENGTH_COLOR = ['var(--danger)', 'var(--danger)', 'var(--warning)', 'var(--success)', 'var(--success)']

export function StepPassphrase({
  joining,
  existingTeamName,
  passphrase,
  onPassphrase,
  teamName,
  onTeamName,
  error,
  shakeKey,
}: {
  joining: boolean
  existingTeamName: string | null
  passphrase: string
  onPassphrase: (v: string) => void
  teamName: string
  onTeamName: (v: string) => void
  error: string | null
  shakeKey: number
}) {
  const score = strengthOf(passphrase)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div>
      <StepTitle
        sub={
          joining
            ? 'Enter the passphrase your team already uses for this folder.'
            : 'Name the team and pick the passphrase everyone will share.'
        }
      >
        {joining ? (
          <>
            Join <span style={{ color: 'var(--accent-text)' }}>{existingTeamName}</span>
          </>
        ) : (
          'Create your team'
        )}
      </StepTitle>

      {!joining && (
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text-2)', marginBottom: 6 }}>
            Team name
            <input
              className="sem-input"
              style={{ marginTop: 6, height: 36 }}
              placeholder="Acme Dev Team"
              value={teamName}
              onChange={(e) => onTeamName(e.target.value)}
              maxLength={48}
            />
          </label>
        </div>
      )}

      <div key={shakeKey} style={{ animation: shakeKey > 0 ? 'sem-shake 300ms var(--ease-standard)' : undefined }}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text-2)' }}>
          Team passphrase
          <input
            ref={inputRef}
            className="sem-input"
            type="password"
            style={{
              marginTop: 6,
              height: 36,
              borderColor: error ? 'var(--danger)' : undefined,
            }}
            placeholder={joining ? 'Enter the team passphrase' : 'A long phrase beats a clever word'}
            value={passphrase}
            onChange={(e) => onPassphrase(e.target.value)}
            aria-invalid={!!error}
            aria-label="Team passphrase"
          />
        </label>
        {error && <DangerText>{error}</DangerText>}
      </div>

      {!joining && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 4 }} aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 2,
                  background: i < score ? STRENGTH_COLOR[score] : 'var(--bg-raised)',
                  transition: 'background var(--t-fast) var(--ease-standard)',
                }}
              />
            ))}
          </div>
          <div style={{ fontSize: 11, color: passphrase ? STRENGTH_COLOR[score] : 'var(--text-3)', marginTop: 4 }}>
            {passphrase ? STRENGTH_LABEL[score] : 'Strength'}
          </div>
        </div>
      )}

      <div
        style={{
          display: 'flex',
          gap: 10,
          marginTop: 16,
          padding: '10px 12px',
          borderRadius: 'var(--r-md)',
          background: 'var(--bg-raised)',
          border: '1px solid var(--border-subtle)',
          fontSize: 12,
          lineHeight: '17px',
          color: 'var(--text-2)',
        }}
      >
        <span style={{ color: 'var(--text-3)', flexShrink: 0, marginTop: 1 }}>
          <IconLock size={14} />
        </span>
        <span>
          Everything written to the folder is encrypted with a key derived from this passphrase. IT can see files
          exist — not what’s in them.
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 3 — identity

export function StepIdentity({
  displayName,
  onDisplayName,
  hostname,
}: {
  displayName: string
  onDisplayName: (v: string) => void
  hostname: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  const previewName = displayName.trim() || 'You'

  return (
    <div>
      <StepTitle sub="The name teammates see. Your device signature is added automatically — nobody can fake being you.">
        Introduce yourself
      </StepTitle>

      <input
        ref={inputRef}
        className="sem-input"
        style={{ height: 36 }}
        placeholder="Ana Ruiz"
        value={displayName}
        onChange={(e) => onDisplayName(e.target.value)}
        maxLength={48}
        aria-label="Display name"
      />

      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--text-3)', margin: '18px 0 8px' }}>
        PREVIEW
      </div>
      <div
        style={{
          display: 'flex',
          gap: 12,
          padding: '12px 16px',
          borderRadius: 'var(--r-lg)',
          background: 'var(--bg-app)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <Avatar name={previewName} size={36} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
            <span style={{ ...truncate, fontSize: 15, fontWeight: 600, color: 'var(--text-1)' }}>{previewName}</span>
            <DeviceChip hostname={hostname || 'this-machine'} fingerprint="····" />
            <span style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
              {formatTime(Date.now())}
            </span>
          </div>
          <div style={{ fontSize: 15, lineHeight: '22px', color: 'var(--text-1)', marginTop: 2, userSelect: 'text' }}>
            Hey team — I just joined Chat 👋
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 4 — device signature

export function StepDevice({
  hostname,
  error,
}: {
  hostname: string
  error: string | null
}) {
  return (
    <div>
      <StepTitle sub="Shown beside your name everywhere — it’s how teammates know it’s really you.">
        Your device signature
      </StepTitle>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
          padding: '28px 16px',
          borderRadius: 'var(--r-lg)',
          background: 'var(--bg-input)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <span
          title="Your device signature — derived from this machine"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 22,
            fontWeight: 500,
            color: 'var(--text-1)',
            background: 'var(--bg-raised)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--r-md)',
            padding: '8px 18px',
            userSelect: 'text',
            animation: 'sem-pop var(--t-base) var(--ease-pop)',
          }}
        >
          {hostname || 'this-machine'}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-3)' }}>
          <IconLock size={13} />
          derived from this machine — it can’t be edited
        </span>
      </div>

      {error && <DangerText>{error}</DangerText>}
    </div>
  )
}
