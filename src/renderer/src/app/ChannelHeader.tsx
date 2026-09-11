import type { ConvId } from '@shared/types'
import { useStore } from '@/store'
import { Avatar, DeviceChip, IconButton, identityHue } from '@/ui/atoms'
import { ShareButton } from '@/screenshare/ShareUi'
import { truncate } from './chrome'
import { IconLock, IconPanel, IconPin } from './icons'
import { useDmMap, useGroupMap } from './dm'
import type { RailTab } from './RightRail'

// Spec §2.3 — 52px conversation header with the right-rail controls.

export default function ChannelHeader({
  conv,
  railOpen,
  railTab,
  onToggleRail,
  onOpenTab,
}: {
  conv: ConvId
  railOpen: boolean
  railTab: RailTab
  onToggleRail: () => void
  onOpenTab: (tab: RailTab) => void
}) {
  const channels = useStore((s) => s.channels)
  const presence = useStore((s) => s.presence)
  const dmPeers = useDmMap((s) => s.peers)
  const groupMap = useGroupMap()

  const channel = channels.find((c) => c.conv === conv)
  const group = groupMap[conv]
  const peer = presence.find((p) => p.deviceId === dmPeers[conv])
  const members = presence.filter((p) => !p.departed).length + 1

  return (
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
      {channel ? (
        <>
          <span
            aria-hidden="true"
            style={{
              fontSize: 17,
              fontWeight: 600,
              color: identityHue(channel.name),
              filter: 'saturate(0.6)',
              userSelect: 'none',
            }}
          >
            #
          </span>
          <span style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-1)', whiteSpace: 'nowrap' }}>
            {channel.name}
          </span>
          <span style={{ fontSize: 13, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
            {members} member{members === 1 ? '' : 's'}
          </span>
          {channel.topic ? (
            <span
              title={channel.topic}
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
              {channel.topic}
            </span>
          ) : (
            <span style={{ flex: 1 }} />
          )}
        </>
      ) : group ? (
        <>
          <span aria-hidden="true" style={{ display: 'flex', color: 'var(--text-2)' }}>
            <IconLock size={16} />
          </span>
          <span style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-1)', whiteSpace: 'nowrap' }}>
            {group.name}
          </span>
          <span style={{ fontSize: 13, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
            {group.members.length} member{group.members.length === 1 ? '' : 's'}
          </span>
          <span style={{ flex: 1 }} />
        </>
      ) : peer ? (
        <>
          <Avatar name={peer.name} size={24} presence={peer.state} />
          <span style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-1)', whiteSpace: 'nowrap' }}>{peer.name}</span>
          <DeviceChip hostname={peer.hostname} fingerprint={peer.fingerprint} warn={peer.trust === 'flagged'} />
          <span style={{ ...truncate, flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text-3)' }}>
            {peer.status || (peer.state === 'online' ? 'online' : peer.state)}
          </span>
        </>
      ) : (
        <>
          <span style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-1)' }}>Direct message</span>
          <span style={{ flex: 1 }} />
        </>
      )}

      <ShareButton conv={conv} />
      <IconButton
        label={railOpen && railTab === 'pinned' ? 'Hide pinned messages' : 'Show pinned messages'}
        active={railOpen && railTab === 'pinned'}
        onClick={() => onOpenTab('pinned')}
      >
        <IconPin size={16} />
      </IconButton>
      <IconButton label={railOpen ? 'Hide details' : 'Show details'} active={railOpen} onClick={onToggleRail}>
        <IconPanel size={16} />
      </IconButton>
    </div>
  )
}
