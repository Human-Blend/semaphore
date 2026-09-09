import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsView } from '@shared/bridge'
import { useStore, selfOf } from '@/store'
import { Avatar, DeviceChip, Spinner } from '@/ui/atoms'
import { SectionLabel, Toggle, isMac, truncate } from './chrome'
import { IconLock } from './icons'
import { toast } from './toasts'

// Spec §2.6 — settings modal, 720×520, left nav.

type Section = 'profile' | 'appearance' | 'notifications' | 'privacy' | 'storage' | 'about'

const NAV: { id: Section; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'storage', label: 'Storage & Share' },
  { id: 'about', label: 'About' },
]

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
            padding: '0 12px',
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

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <SectionLabel>{label}</SectionLabel>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: '15px' }}>{hint}</div>}
    </div>
  )
}

function ToggleRow({
  label,
  sub,
  on,
  onChange,
}: {
  label: string
  sub?: string
  on: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, color: 'var(--text-1)' }}>{label}</span>
        {sub && <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>{sub}</span>}
      </span>
      <Toggle on={on} onChange={onChange} label={label} />
    </div>
  )
}

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings)
  const refreshSettings = useStore((s) => s.refreshSettings)
  const health = useStore((s) => s.health)
  const boot = useStore((s) => s.boot)
  const self = selfOf(boot)
  const [section, setSection] = useState<Section>('profile')
  const [confirmingFolderChange, setConfirmingFolderChange] = useState(false)

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function patch(p: Partial<SettingsView>) {
    try {
      await window.bridge.settings.set(p)
      await refreshSettings()
    } catch {
      toast('Could not save that setting', 'danger')
    }
  }

  return (
    <div
      onClick={onClose}
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'var(--bg-overlay)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'sem-fade var(--t-fast) var(--ease-standard)',
      }}
    >
      <div
        role="dialog"
        aria-label="Settings"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 720,
          height: 520,
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: 'calc(100vh - 48px)',
          display: 'flex',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--elev-3)',
          overflow: 'hidden',
          animation: 'sem-pop var(--t-base) var(--ease-pop)',
        }}
      >
        <div
          style={{
            width: 160,
            flexShrink: 0,
            background: 'var(--bg-sidebar)',
            borderRight: '1px solid var(--border-subtle)',
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-1)', padding: '10px 10px 12px' }}>Settings</div>
          {NAV.map((n) => (
            <button
              key={n.id}
              className="sem-row sem-focus"
              onClick={() => setSection(n.id)}
              title={n.label}
              aria-current={section === n.id}
              style={{
                height: 30,
                padding: '0 10px',
                borderRadius: 'var(--r-sm)',
                fontSize: 13,
                fontWeight: section === n.id ? 600 : 400,
                color: section === n.id ? 'var(--text-1)' : 'var(--text-2)',
                background: section === n.id ? 'var(--accent-soft)' : undefined,
              }}
            >
              {n.label}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <button
            className="sem-row sem-focus"
            onClick={onClose}
            title="Close settings (Esc)"
            style={{ height: 30, padding: '0 10px', borderRadius: 'var(--r-sm)', fontSize: 13, color: 'var(--text-3)' }}
          >
            Close
          </button>
        </div>

        <div className="sem-scroll" style={{ flex: 1, minWidth: 0, padding: 24 }}>
          {!settings ? (
            <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
              <Spinner />
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
              {section === 'profile' && self && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <Avatar name={self.displayName} size={56} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-1)' }}>{self.displayName}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>{self.teamName}</div>
                    </div>
                  </div>
                  <Field label="Display name" hint="Name changes announce themselves in channels, so identity can't silently swap.">
                    <input className="sem-input" value={self.displayName} disabled aria-label="Display name (read-only)" style={{ maxWidth: 280 }} />
                  </Field>
                  <Field label="Device signature">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <DeviceChip hostname={self.hostname} fingerprint={self.fingerprint} full />
                      <span style={{ color: 'var(--text-3)', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                        <IconLock size={12} /> Derived from this machine — visible to teammates, not editable.
                      </span>
                    </div>
                  </Field>
                </>
              )}

              {section === 'appearance' && (
                <>
                  <Field label="Theme">
                    <Segmented
                      label="Theme"
                      value={settings.theme}
                      options={[
                        { v: 'system' as const, label: 'System' },
                        { v: 'dark' as const, label: 'Dark' },
                        { v: 'light' as const, label: 'Light' },
                      ]}
                      onChange={(v) => void patch({ theme: v })}
                    />
                  </Field>
                  <Field label="Message text size" hint="S = 14px · M = 15px · L = 16px">
                    <Segmented
                      label="Message text size"
                      value={settings.fontSize}
                      options={[
                        { v: 'S' as const, label: 'S' },
                        { v: 'M' as const, label: 'M' },
                        { v: 'L' as const, label: 'L' },
                      ]}
                      onChange={(v) => void patch({ fontSize: v })}
                    />
                  </Field>
                  <Field label="Autoplay GIFs">
                    <Segmented
                      label="Autoplay GIFs"
                      value={settings.autoplayGifs}
                      options={[
                        { v: 'always' as const, label: 'Always' },
                        { v: 'hover' as const, label: 'While hovered' },
                        { v: 'never' as const, label: 'Never' },
                      ]}
                      onChange={(v) => void patch({ autoplayGifs: v })}
                    />
                  </Field>
                </>
              )}

              {section === 'notifications' && (
                <>
                  <Field label="Channel messages">
                    <Segmented
                      label="Notify for channel messages"
                      value={settings.notifyChannels}
                      options={[
                        { v: 'all' as const, label: 'All' },
                        { v: 'mentions' as const, label: 'Mentions only' },
                        { v: 'none' as const, label: 'Nothing' },
                      ]}
                      onChange={(v) => void patch({ notifyChannels: v })}
                    />
                  </Field>
                  <ToggleRow
                    label="Show message content in notifications"
                    sub="Off shows only who wrote, never what."
                    on={settings.notifyPreviews}
                    onChange={(v) => void patch({ notifyPreviews: v })}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <ToggleRow
                      label="Quiet hours"
                      sub="Suppresses OS notifications and badges; the app still updates."
                      on={settings.quietHours.enabled}
                      onChange={(v) => void patch({ quietHours: { ...settings.quietHours, enabled: v } })}
                    />
                    {settings.quietHours.enabled && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 2 }}>
                        <input
                          type="time"
                          className="sem-input"
                          style={{ width: 104 }}
                          value={settings.quietHours.from}
                          aria-label="Quiet hours start"
                          onChange={(e) => void patch({ quietHours: { ...settings.quietHours, from: e.target.value } })}
                        />
                        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>to</span>
                        <input
                          type="time"
                          className="sem-input"
                          style={{ width: 104 }}
                          value={settings.quietHours.to}
                          aria-label="Quiet hours end"
                          onChange={(e) => void patch({ quietHours: { ...settings.quietHours, to: e.target.value } })}
                        />
                      </div>
                    )}
                  </div>
                </>
              )}

              {section === 'privacy' && (
                <ToggleRow
                  label="Automatically accept beams from teammates"
                  sub="Off by default. Beams from new or flagged devices always ask first."
                  on={settings.autoAcceptBeams}
                  onChange={(v) => void patch({ autoAcceptBeams: v })}
                />
              )}

              {section === 'storage' && self && (
                <>
                  <Field label="Team folder">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        title={self.sharePath}
                        style={{
                          ...truncate,
                          flex: 1,
                          minWidth: 0,
                          fontFamily: 'var(--font-mono)',
                          fontSize: 12,
                          color: 'var(--text-2)',
                          background: 'var(--bg-input)',
                          border: '1px solid var(--border-subtle)',
                          borderRadius: 'var(--r-sm)',
                          padding: '6px 10px',
                          userSelect: 'text',
                        }}
                      >
                        {self.sharePath}
                      </span>
                      <button
                        className="sem-chip-btn"
                        onClick={() => void window.bridge.app.showInFolder(self.sharePath)}
                        title={isMac ? 'Show in Finder' : 'Show in file manager'}
                      >
                        {isMac ? 'Show in Finder' : 'Show in Explorer'}
                      </button>
                    </div>
                  </Field>
                  <Field label="Share health">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-2)' }}>
                      <span
                        aria-hidden="true"
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: health.reachable ? 'var(--success)' : 'var(--danger)',
                        }}
                      />
                      {health.reachable
                        ? `Connected${health.latencyMs !== null ? ` · ${health.latencyMs}ms` : ''}`
                        : 'Unreachable — retrying'}
                    </div>
                  </Field>
                  <Field label="Change team folder">
                    <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: '17px', marginBottom: 8 }}>
                      Everyone who picks the same folder lands in the same team — switching folders
                      switches teams. Your name and this device's identity are kept; messages stay
                      (encrypted) in the old folder.
                    </div>
                    {confirmingFolderChange ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 13, color: 'var(--warning)' }}>
                          Disconnect and re-run setup?
                        </span>
                        <button
                          className="sem-chip-btn"
                          style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
                          onClick={() => void window.bridge.app.changeTeamFolder()}
                        >
                          Yes, change folder
                        </button>
                        <button className="sem-chip-btn" onClick={() => setConfirmingFolderChange(false)}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button className="sem-chip-btn" onClick={() => setConfirmingFolderChange(true)}>
                        Change team folder…
                      </button>
                    )}
                  </Field>
                </>
              )}

              {section === 'about' && (
                <>
                  <div>
                    <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-1)' }}>Chat</div>
                    <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 4 }}>
                      Serverless team chat over an encrypted shared folder.
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: 'var(--text-2)' }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <span style={{ width: 90, color: 'var(--text-3)' }}>Electron</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, userSelect: 'text' }}>
                        {window.bridge.versions.electron}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <span style={{ width: 90, color: 'var(--text-3)' }}>Chrome</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, userSelect: 'text' }}>
                        {window.bridge.versions.chrome}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <span style={{ width: 90, color: 'var(--text-3)' }}>Platform</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{window.bridge.platform}</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
