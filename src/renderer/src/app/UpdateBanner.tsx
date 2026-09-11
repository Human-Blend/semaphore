import { useEffect, useState } from 'react'
import { useStore } from '@/store'
import { Button } from '@/ui/atoms'
import { toast } from './toasts'
import {
  dismissedFor,
  forgetPeerDismissal,
  peerSentence,
  rememberLater,
  type UpdateSource,
} from './updateBannerState'

// Spec §10 — the update surface. Non-blocking: a subtle bottom-left chip.
// Blocking (below minSupported): a modal that explains, still no auto-install —
// the human always performs the copy-and-swap.
//
// 1.2 adds a second source. A teammate's beacon now carries their Chat version,
// so this machine can learn that it is behind before anyone has copied the new
// zip into the team folder. That banner can't offer a copy (there is nothing to
// copy yet), so it names the person and opens the apps folder instead, and
// flips to the normal one the moment the signed manifest lands.

// The dismissal keys and the peer wording live in ./updateBannerState so the suite
// (node environment, no DOM) can pin them.

export function UpdateBanner() {
  const update = useStore((s) => s.update)
  const [busy, setBusy] = useState(false)
  const [hidden, setHidden] = useState(false)
  const version = update?.version ?? ''
  const source: UpdateSource = update?.source === 'peer' ? 'peer' : 'manifest'
  const isPeer = source === 'peer'

  // A new version — or the same version arriving from a source this machine has
  // not been told to hush — resets the session dismissal. The manifest banner
  // also clears any peer dismissal for that version: once the zip is really
  // there, "remind me later" about the rumour has been answered.
  useEffect(() => {
    if (!version) {
      setHidden(false)
      return
    }
    if (source === 'manifest') forgetPeerDismissal(version)
    setHidden(dismissedFor(version, source))
  }, [version, source])

  if (!update || (hidden && !update.blocking)) return null

  const copy = async () => {
    setBusy(true)
    try {
      const res = await window.bridge.update.copyToMachine()
      if ('path' in res) {
        toast(`Update copied — quit Chat, extract, and replace the app.`)
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

  const openApps = async () => {
    try {
      await window.bridge.app.openAppsFolder()
    } catch {
      toast('Could not open the apps folder — is the team folder reachable?')
    }
  }

  const remindLater = () => {
    rememberLater(update.version, source)
    setHidden(true)
  }

  if (update.blocking) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 990, background: 'var(--bg-overlay)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 420, background: 'var(--bg-panel)', borderRadius: 'var(--r-xl)', border: '1px solid var(--border-strong)', boxShadow: 'var(--elev-3)', padding: 24 }}>
          <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>Update required</div>
          <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: '19px' }}>
            This version of Chat can no longer read the team's message format. Copy version {update.version} from the
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

  const linkStyle = {
    border: 'none',
    background: 'transparent',
    color: 'var(--accent-text)',
    fontWeight: 600,
    fontSize: 12,
    cursor: 'pointer',
  } as const

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
      {isPeer ? (
        <>
          {/* A peer beacon is a claim, not a release: nothing here has been
              verified against the baked release key, so the wording names who
              is saying it and never says an update "is available". */}
          <span>{peerSentence(update.peerName, update.version)}</span>
          <button onClick={() => void openApps()} style={linkStyle}>
            Open apps folder
          </button>
          <button onClick={remindLater} style={{ ...linkStyle, color: 'var(--text-3)', fontWeight: 400 }}>
            Remind me later
          </button>
        </>
      ) : (
        <>
          Chat {update.version} is available
          <button onClick={() => void copy()} disabled={busy} style={linkStyle}>
            {busy ? 'Copying…' : 'Copy to my machine'}
          </button>
        </>
      )}
      <button onClick={() => setHidden(true)} title="Dismiss" style={{ border: 'none', background: 'transparent', color: 'var(--text-3)', cursor: 'pointer', fontSize: 13 }}>
        ×
      </button>
    </div>
  )
}
