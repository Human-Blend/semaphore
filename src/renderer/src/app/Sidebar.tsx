import { useEffect, useMemo, useRef, useState } from 'react'
import type { PresenceView } from '@shared/types'
import { useStore, selfOf } from '@/store'
import { Avatar, DeviceChip, identityHue } from '@/ui/atoms'
import { SectionLabel, Toggle, truncate } from './chrome'
import { IconGear, IconPlus } from './icons'
import { useBeamTarget, BeamLabel } from './beam'
import { openDm, useDmMap } from './dm'
import { toast } from './toasts'
import QuickSwitcher from './QuickSwitcher'

// Spec §2.2 — the sidebar: quick switcher, channels, DMs (beam drop targets),
// self footer with status popover. The team block lives in the titlebar row.

function ChannelRow({
  conv,
  name,
  active,
  unread,
  onClick,
}: {
  conv: string
  name: string
  active: boolean
  unread: number
  onClick: () => void
}) {
  void conv
  const hasUnread = unread > 0
  return (
    <button
      className="sem-row"
      onClick={onClick}
      title={`#${name}`}
      aria-label={`Channel ${name}${hasUnread ? `, ${unread} unread` : ''}`}
      style={{
        position: 'relative',
        width: '100%',
        height: 30,
        gap: 8,
        padding: '0 8px 0 10px',
        borderRadius: 'var(--r-sm)',
        background: active ? 'var(--accent-soft)' : undefined,
      }}
    >
      {active && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 0,
            top: 7,
            bottom: 7,
            width: 2,
            borderRadius: 2,
            background: 'var(--accent)',
          }}
        />
      )}
      <span
        aria-hidden="true"
        style={{
          width: 14,
          textAlign: 'center',
          fontWeight: 600,
          fontSize: 13,
          color: identityHue(name),
          filter: 'saturate(0.6)',
          flexShrink: 0,
          userSelect: 'none',
        }}
      >
        #
      </span>
      <span
        style={{
          ...truncate,
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          fontWeight: hasUnread ? 600 : 400,
          color: active || hasUnread ? 'var(--text-1)' : 'var(--text-2)',
          transition: 'color var(--t-fast) var(--ease-standard)',
        }}
      >
        {name}
      </span>
      {hasUnread && (
        <span
          style={{
            minWidth: 18,
            height: 16,
            padding: '0 5px',
            borderRadius: 'var(--r-full)',
            background: 'var(--accent)',
            color: 'var(--on-accent)',
            fontSize: 11,
            fontWeight: 600,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  )
}

function DmRow({ p, active }: { p: PresenceView; active: boolean }) {
  const beam = useBeamTarget(p.deviceId, p.name)
  const offline = p.state === 'offline'
  return (
    <button
      className="sem-row"
      onClick={() => void openDm(p.deviceId)}
      title={`Message ${p.name} (${p.hostname})`}
      aria-label={`Direct message ${p.name}, ${p.state}`}
      {...beam.props}
      style={{
        position: 'relative',
        width: '100%',
        height: beam.over ? 44 : 36,
        gap: 8,
        padding: '0 8px',
        borderRadius: 'var(--r-sm)',
        background: beam.over ? 'var(--flare-soft)' : active ? 'var(--accent-soft)' : undefined,
        boxShadow: beam.over ? 'inset 0 0 0 1px var(--flare)' : undefined,
        transition:
          'height var(--t-fast) var(--ease-standard), background var(--t-fast) var(--ease-standard), box-shadow var(--t-fast) var(--ease-standard)',
      }}
    >
      {beam.over ? (
        <BeamLabel name={p.name} />
      ) : (
        <>
          {active && (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: 0,
                top: 9,
                bottom: 9,
                width: 2,
                borderRadius: 2,
                background: 'var(--accent)',
              }}
            />
          )}
          <Avatar name={p.name} size={24} presence={p.state} desaturate={p.state === 'away'} />
          <span
            style={{
              ...truncate,
              flex: 1,
              minWidth: 0,
              fontSize: 13,
              color: offline ? 'var(--text-3)' : 'var(--text-1)',
              transition: 'color var(--t-slow) var(--ease-standard)',
            }}
          >
            {p.name}
          </span>
          <DeviceChip hostname={p.hostname} fingerprint={p.fingerprint} warn={p.trust === 'flagged'} />
        </>
      )}
    </button>
  )
}

function StatusPopover({
  currentStatus,
  appearOffline,
  onClose,
}: {
  currentStatus: string
  appearOffline: boolean
  onClose: () => void
}) {
  const [text, setText] = useState(currentStatus)
  const [offline, setOffline] = useState(appearOffline)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  async function save() {
    try {
      await window.bridge.presence.setStatus(text.trim())
      toast(text.trim() ? 'Status set' : 'Status cleared', 'success')
      onClose()
    } catch {
      toast('Could not set status', 'danger')
    }
  }

  async function setAppear(v: boolean) {
    setOffline(v)
    try {
      await window.bridge.presence.setAppearState(v ? 'offline' : 'online')
    } catch {
      toast('Could not change presence', 'danger')
    }
  }

  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 70 }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-label="Status"
        className="sem-frost"
        style={{
          position: 'absolute',
          left: 8,
          right: 8,
          bottom: 58,
          zIndex: 71,
          borderRadius: 'var(--r-lg)',
          border: '1px solid var(--border-subtle)',
          boxShadow: 'var(--elev-2)',
          padding: 12,
          animation: 'sem-rise var(--t-base) var(--ease-pop)',
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--text-3)', marginBottom: 6 }}>
          STATUS
        </div>
        <input
          ref={inputRef}
          className="sem-input"
          placeholder="What's happening?"
          value={text}
          maxLength={80}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
            if (e.key === 'Escape') onClose()
          }}
          aria-label="Status text"
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <button
            className="sem-chip-btn"
            onClick={() => void save()}
            title="Save status"
            style={{ height: 24, fontSize: 11 }}
          >
            Save
          </button>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 10,
            paddingTop: 10,
            borderTop: '1px solid var(--border-subtle)',
          }}
        >
          <span style={{ fontSize: 13, color: 'var(--text-2)' }}>Appear offline</span>
          <Toggle on={offline} onChange={(v) => void setAppear(v)} label="Appear offline" />
        </div>
      </div>
    </>
  )
}

export default function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const channels = useStore((s) => s.channels)
  const presence = useStore((s) => s.presence)
  const boot = useStore((s) => s.boot)
  const activeConv = useStore((s) => s.activeConv)
  const setActiveConv = useStore((s) => s.setActiveConv)
  // Subscribed so unread counts refresh as events/read-cursors change.
  useStore((s) => s.events)
  useStore((s) => s.myReads)
  const unreadCount = useStore((s) => s.unreadCount)
  const dmPeers = useDmMap((s) => s.peers)
  const self = selfOf(boot)

  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [statusOpen, setStatusOpen] = useState(false)
  const addRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (adding) addRef.current?.focus()
  }, [adding])

  const others = useMemo(() => {
    const list = presence.filter((p) => p.deviceId !== self?.deviceId)
    const rank = { online: 0, away: 1, offline: 2 } as const
    list.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name))
    return list
  }, [presence, self?.deviceId])

  const selfPresence = presence.find((p) => p.deviceId === self?.deviceId)

  async function createChannel() {
    const name = newName.trim().toLowerCase().replace(/\s+/g, '-').replace(/^#/, '')
    if (!name) {
      setAdding(false)
      return
    }
    try {
      const ch = await window.bridge.chat.createChannel(name)
      setActiveConv(ch.conv)
      setAdding(false)
      setNewName('')
    } catch (err) {
      toast(`Could not create #${name} — ${err instanceof Error ? err.message : String(err)}`, 'danger')
    }
  }

  return (
    <div
      style={{
        width: 260,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-sidebar)',
        borderRight: '1px solid var(--border-subtle)',
        position: 'relative',
        minHeight: 0,
      }}
    >
      <QuickSwitcher />

      <div className="sem-scroll" style={{ flex: 1, minHeight: 0, padding: '4px 8px 8px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 8px 4px',
          }}
        >
          <SectionLabel>Channels</SectionLabel>
          <button
            className="sem-row sem-focus"
            onClick={() => setAdding(true)}
            title="Create a channel"
            aria-label="Create a channel"
            style={{
              width: 18,
              height: 18,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 'var(--r-xs)',
              color: 'var(--text-3)',
            }}
          >
            <IconPlus size={12} />
          </button>
        </div>

        {adding && (
          <div style={{ padding: '2px 0 4px' }}>
            <input
              ref={addRef}
              className="sem-input"
              style={{ height: 28, fontSize: 12 }}
              placeholder="channel-name"
              aria-label="New channel name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createChannel()
                if (e.key === 'Escape') {
                  setAdding(false)
                  setNewName('')
                }
              }}
              onBlur={() => {
                setAdding(false)
                setNewName('')
              }}
              spellCheck={false}
            />
          </div>
        )}

        {channels.map((ch) => (
          <ChannelRow
            key={ch.conv}
            conv={ch.conv}
            name={ch.name}
            active={activeConv === ch.conv}
            unread={activeConv === ch.conv ? 0 : unreadCount(ch.conv)}
            onClick={() => setActiveConv(ch.conv)}
          />
        ))}
        {!channels.length && (
          <div style={{ padding: '4px 8px', fontSize: 12, color: 'var(--text-3)' }}>No channels yet — create one.</div>
        )}

        <div style={{ padding: '16px 8px 4px' }}>
          <SectionLabel>Direct messages</SectionLabel>
        </div>
        {others.map((p) => (
          <DmRow key={p.deviceId} p={p} active={activeConv !== null && dmPeers[activeConv] === p.deviceId} />
        ))}
        {!others.length && (
          <div style={{ padding: '4px 8px', fontSize: 12, color: 'var(--text-3)' }}>
            Nobody else yet. Teammates appear here when they join the folder.
          </div>
        )}
      </div>

      {self && (
        <div
          style={{
            height: 52,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 8px',
            borderTop: '1px solid var(--border-subtle)',
            position: 'relative',
          }}
        >
          <button
            className="sem-row"
            onClick={() => setStatusOpen((v) => !v)}
            title="Set your status"
            aria-label="Set your status"
            aria-expanded={statusOpen}
            style={{ flex: 1, minWidth: 0, height: 40, gap: 8, padding: '0 6px', borderRadius: 'var(--r-sm)' }}
          >
            <Avatar name={self.displayName} size={28} presence={selfPresence?.state ?? 'online'} />
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ ...truncate, display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>
                {self.displayName}
              </span>
              <span style={{ ...truncate, display: 'block', fontSize: 11, color: 'var(--text-3)' }}>
                {selfPresence?.status || 'Set a status'}
              </span>
            </span>
          </button>
          <DeviceChip hostname={self.hostname} fingerprint={self.fingerprint} />
          <button
            className="sem-row sem-focus"
            onClick={onOpenSettings}
            title="Settings"
            aria-label="Open settings"
            style={{
              width: 28,
              height: 28,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 'var(--r-sm)',
              color: 'var(--text-2)',
            }}
          >
            <IconGear size={16} />
          </button>

          {statusOpen && (
            <StatusPopover
              currentStatus={selfPresence?.status ?? ''}
              appearOffline={selfPresence?.state === 'offline'}
              onClose={() => setStatusOpen(false)}
            />
          )}
        </div>
      )}
    </div>
  )
}
