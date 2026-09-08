import { useState } from 'react'
import { useStore } from '@/store'
import { Button } from '@/ui/atoms'
import { toast } from './toasts'

// Spec §10 — the update surface. Non-blocking: a subtle bottom-left chip.
// Blocking (below minSupported): a modal that explains, still no auto-install —
// the human always performs the copy-and-swap.

export function UpdateBanner() {
  const update = useStore((s) => s.update)
  const [busy, setBusy] = useState(false)
  const [hidden, setHidden] = useState(false)

  if (!update || (hidden && !update.blocking)) return null

  const copy = async () => {
    setBusy(true)
    try {
      const res = await window.bridge.update.copyToMachine()
      if ('path' in res) {
        toast(`Update copied — quit Semaphore, extract, and replace the app.`)
        void window.bridge.app.showInFolder(res.path)
      } else {
        toast(res.error)
      }
    } catch {
      toast('Could not copy the update — is the team folder reachable?')
    } finally {
      setBusy(false)
    }
  }

  if (update.blocking) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 990, background: 'var(--bg-overlay)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 420, background: 'var(--bg-panel)', borderRadius: 'var(--r-xl)', border: '1px solid var(--border-strong)', boxShadow: 'var(--elev-3)', padding: 24 }}>
          <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>Update required</div>
          <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: '19px' }}>
            This version of Semaphore can no longer read the team's message format. Copy version {update.version} from the
            team folder, quit, extract, and replace the app.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <Button onClick={() => void copy()} disabled={busy}>
              Copy update to my machine
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 12,
        left: 272,
        zIndex: 700,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        background: 'var(--bg-raised)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--r-full)',
        boxShadow: 'var(--elev-2)',
        fontSize: 12,
        color: 'var(--text-2)',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }} />
      Semaphore {update.version} is available
      <button onClick={() => void copy()} disabled={busy} style={{ border: 'none', background: 'transparent', color: 'var(--accent-text)', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>
        {busy ? 'Copying…' : 'Copy to my machine'}
      </button>
      <button onClick={() => setHidden(true)} title="Dismiss" style={{ border: 'none', background: 'transparent', color: 'var(--text-3)', cursor: 'pointer', fontSize: 13 }}>
        ×
      </button>
    </div>
  )
}
