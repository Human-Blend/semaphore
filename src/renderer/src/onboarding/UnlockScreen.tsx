import { useEffect, useRef, useState } from 'react'
import { Button, Spinner } from '@/ui/atoms'
import { ChromeCss } from '@/app/chrome'
import { IconLock } from '@/app/icons'
import { GradientMesh } from './mesh'
import { DangerText } from './steps'

// Passphrase-LMK machines unlock each launch (spec §2.5 sibling). One field;
// a wrong passphrase shakes and explains, nothing else moves.

export default function UnlockScreen() {
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [fails, setFails] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Runs on mount and after each failed attempt (the card is re-keyed).
    inputRef.current?.focus()
  }, [fails])

  async function unlock() {
    if (!pass || busy) return
    setBusy(true)
    const ok = await window.bridge.app.unlock(pass).catch(() => false)
    setBusy(false)
    if (!ok) {
      setFails((f) => f + 1)
      setPass('')
    }
    // On success the boot push swaps App to the shell.
  }

  return (
    <div
      style={{
        position: 'relative',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-app)',
        overflow: 'hidden',
      }}
    >
      <ChromeCss />
      <GradientMesh />

      <div
        key={fails}
        style={{
          position: 'relative',
          width: 380,
          maxWidth: 'calc(100vw - 48px)',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--elev-3)',
          padding: 28,
          textAlign: 'center',
          animation: fails > 0 ? 'sem-shake 300ms var(--ease-standard)' : 'sem-rise var(--t-base) var(--ease-standard)',
        }}
      >
        <div
          style={{
            width: 44,
            height: 44,
            margin: '0 auto 14px',
            borderRadius: 'var(--r-md)',
            background: 'var(--accent-soft)',
            color: 'var(--accent-text)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <IconLock size={20} />
        </div>
        <div style={{ fontSize: 22, fontWeight: 600, lineHeight: '28px', color: 'var(--text-1)' }}>Welcome back</div>
        <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 6, marginBottom: 18 }}>
          Enter your team passphrase to unlock Semaphore.
        </div>

        <input
          ref={inputRef}
          className="sem-input"
          type="password"
          style={{ height: 36, textAlign: 'center', borderColor: fails > 0 ? 'var(--danger)' : undefined }}
          placeholder="Team passphrase"
          aria-label="Team passphrase"
          aria-invalid={fails > 0}
          value={pass}
          disabled={busy}
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void unlock()
          }}
        />
        {fails > 0 && (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <DangerText>Wrong passphrase — try again.</DangerText>
          </div>
        )}

        <Button
          onClick={() => void unlock()}
          disabled={!pass || busy}
          style={{ width: '100%', marginTop: 14, height: 34 }}
        >
          {busy ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <Spinner size={13} /> Unlocking…
            </span>
          ) : (
            'Unlock'
          )}
        </Button>
      </div>
    </div>
  )
}
