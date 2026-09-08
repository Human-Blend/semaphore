import { useEffect, useMemo, useState } from 'react'
import { useStore, selfOf } from '@/store'
import ChatPane from '@/chat/ChatPane'
import { Lightbox } from '@/content/Lightbox'
import { ChromeCss, DRAG, NO_DRAG, isMac, truncate } from './chrome'
import Sidebar from './Sidebar'
import ChannelHeader from './ChannelHeader'
import RightRail from './RightRail'
import type { RailTab } from './RightRail'
import SettingsModal from './SettingsModal'
import { HealthBanner } from './banners'
import { Toasts } from './toasts'
import { NoConvState, EmptyConvOverlay } from './EmptyStates'
import { ActiveShareBanner, ScreenShareRoot } from '@/screenshare/ShareUi'
import { BeamSurface } from './BeamSurface'
import { UpdateBanner } from './UpdateBanner'

// The main three-pane application shell (spec §2). A 44px drag strip spans the
// top; its left segment doubles as the sidebar's team block.

const FONT_PX: Record<'S' | 'M' | 'L', string> = { S: '14px', M: '15px', L: '16px' }

function ConnectionLine() {
  const health = useStore((s) => s.health)
  const slow = health.reachable && health.latencyMs !== null && health.latencyMs >= 500
  const color = !health.reachable ? 'var(--danger)' : slow ? 'var(--warning)' : 'var(--success)'
  const label = !health.reachable
    ? 'Share unreachable'
    : slow
      ? `Share slow · ${health.latencyMs}ms`
      : `Share connected${health.latencyMs !== null ? ` · ${health.latencyMs}ms` : ''}`
  return (
    <span
      title={
        !health.reachable
          ? 'The team folder cannot be reached right now. Messages queue on this machine.'
          : slow
            ? 'The share is responding slowly — messages may take a few seconds to appear.'
            : 'Connected to the team folder.'
      }
      style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-3)', minWidth: 0 }}
    >
      <span
        aria-hidden="true"
        style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }}
      />
      <span style={truncate}>{label}</span>
    </span>
  )
}

function TitleBar() {
  const boot = useStore((s) => s.boot)
  const self = selfOf(boot)
  return (
    <div
      style={{
        ...DRAG,
        height: 44,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'stretch',
        userSelect: 'none',
      }}
    >
      <div
        style={{
          width: 260,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 1,
          padding: isMac ? '0 12px 0 76px' : '0 12px 0 16px',
          background: 'var(--bg-sidebar)',
          borderRight: '1px solid var(--border-subtle)',
          minWidth: 0,
        }}
      >
        <span style={{ ...truncate, fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>
          {self?.teamName ?? 'Semaphore'}
        </span>
        <ConnectionLine />
      </div>
      <div style={{ flex: 1, background: 'var(--bg-app)' }} />
    </div>
  )
}

export default function AppShell() {
  const activeConv = useStore((s) => s.activeConv)
  const settings = useStore((s) => s.settings)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [railOpen, setRailOpen] = useState(true)
  const [railTab, setRailTab] = useState<RailTab>('about')

  // Theme + font size (spec §2.6): 'system' clears the attribute, dark is the
  // token default; applied on boot and whenever settings change.
  const theme = settings?.theme ?? 'system'
  const fontSize = settings?.fontSize ?? 'M'
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') delete root.dataset.theme
    else root.dataset.theme = theme
  }, [theme])
  useEffect(() => {
    document.documentElement.style.setProperty('--text-msg', FONT_PX[fontSize])
  }, [fontSize])

  // Rail defaults: open in channels, closed in DMs (spec §2.4).
  const convKind = useMemo(
    () => (activeConv === null ? 'none' : activeConv.startsWith('dm:') ? 'dm' : 'chan'),
    [activeConv],
  )
  useEffect(() => {
    setRailOpen(convKind === 'chan')
    if (convKind !== 'none') setRailTab('about')
  }, [convKind])

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-app)',
        color: 'var(--text-1)',
        overflow: 'hidden',
      }}
    >
      <ChromeCss />
      <TitleBar />

      <div style={{ flex: 1, minHeight: 0, display: 'flex', ...NO_DRAG }}>
        <Sidebar onOpenSettings={() => setSettingsOpen(true)} />

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {activeConv ? (
            <>
              <ChannelHeader
                conv={activeConv}
                railOpen={railOpen}
                railTab={railTab}
                onToggleRail={() => setRailOpen((v) => !v)}
                onOpenTab={(tab) => {
                  if (railOpen && railTab === tab) setRailOpen(false)
                  else {
                    setRailTab(tab)
                    setRailOpen(true)
                  }
                }}
              />
              <HealthBanner />
              <ActiveShareBanner conv={activeConv} />
              <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                <ChatPane conv={activeConv} />
                <EmptyConvOverlay conv={activeConv} />
              </div>
            </>
          ) : (
            <>
              <HealthBanner />
              <NoConvState />
            </>
          )}
        </div>

        {railOpen && activeConv && (
          <RightRail conv={activeConv} tab={railTab} onTab={setRailTab} onClose={() => setRailOpen(false)} />
        )}
      </div>

      <Toasts />
      <Lightbox />
      <ScreenShareRoot />
      <BeamSurface />
      <UpdateBanner />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
