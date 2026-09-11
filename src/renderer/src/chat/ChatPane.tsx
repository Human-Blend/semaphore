import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type { ConvId } from '@shared/types'
import type { AttachDraft } from '@shared/bridge'
import { isChanConv, isGrpConv } from '@shared/ids'
import { materialize } from '@shared/merge'
import type { MessageView } from '@shared/merge'
import { useStore, selfOf } from '@/store'
import { MessageList } from './MessageList'
import { Composer } from './Composer'
import type { ComposerApi } from './Composer'
import { TypingLane } from './TypingLane'
import { sniffDroppedDiagram } from '@/diagram/scene'
import { CHAT_CSS, EMPTY, UNKNOWN_CHIP, buildAttachment, type ChipData } from './util'
import { UploadIcon } from './icons'

// The conversation pane: scrolling message area + typing lane + composer.
// The channel header above is owned by the shell.

export default function ChatPane({ conv }: { conv: ConvId }) {
  const events = useStore((s) => s.events[conv] ?? EMPTY)
  const loaded = useStore((s) => s.eventsLoaded[conv] ?? false)
  const presence = useStore((s) => s.presence)
  const channels = useStore((s) => s.channels)
  const groups = useStore((s) => s.groups)
  const boot = useStore((s) => s.boot)
  const self = selfOf(boot)
  const selfId = self?.deviceId ?? ''

  const log = useMemo(() => materialize(events), [events])
  const logRef = useRef(log)
  logRef.current = log

  // Unread anchor: my read watermark captured once when the conv opens,
  // held stable while viewing so the NEW divider doesn't chase itself.
  const [anchor, setAnchor] = useState<{ conv: ConvId; read: string }>(() => ({
    conv,
    read: useStore.getState().myReads[conv] ?? '',
  }))
  if (anchor.conv !== conv) setAnchor({ conv, read: useStore.getState().myReads[conv] ?? '' })

  useEffect(() => {
    void useStore.getState().ensureEvents(conv)
  }, [conv])

  const [replyToId, setReplyToId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  useEffect(() => {
    setReplyToId(null)
    setEditingId(null)
  }, [conv])

  const composerRef = useRef<ComposerApi | null>(null)

  const byId = useMemo(() => {
    const map = new Map<string, MessageView>()
    for (const m of log.messages) map.set(m.id, m)
    return map
  }, [log])
  const byIdRef = useRef(byId)
  byIdRef.current = byId
  const getMessage = useCallback((id: string) => byIdRef.current.get(id), [])

  const chipMap = useMemo(() => {
    const map = new Map<string, ChipData>()
    for (const p of presence)
      map.set(p.deviceId, {
        hostname: p.hostname,
        fingerprint: p.fingerprint,
        warn: p.trust === 'flagged' || p.trust === 'revoked',
      })
    if (self) map.set(self.deviceId, { hostname: self.hostname, fingerprint: self.fingerprint, warn: false })
    return map
  }, [presence, self])
  const chipOf = useCallback((device: string) => chipMap.get(device) ?? UNKNOWN_CHIP, [chipMap])

  const nameOf = useCallback(
    (device: string) => {
      if (self && device === self.deviceId) return self.displayName
      return presence.find((p) => p.deviceId === device)?.name ?? (device.slice(0, 8) || 'unknown')
    },
    [presence, self],
  )

  const label = useMemo(() => {
    if (isChanConv(conv)) {
      const c = channels.find((ch) => ch.conv === conv)
      return c ? `#${c.name}` : 'this channel'
    }
    // Private groups (1.2): named like a channel (no leading '#'), never
    // inferred from the last non-self sender — a group can have more than
    // one other member, so "who else spoke last" isn't a stable label.
    if (isGrpConv(conv)) {
      const g = groups.find((gr) => gr.conv === conv)
      return g ? g.name : 'this group'
    }
    for (let i = log.messages.length - 1; i >= 0; i--) {
      const m = log.messages[i]
      if (m.authorDevice !== selfId) return m.authorName
    }
    return 'this conversation'
  }, [conv, channels, groups, log, selfId])

  const onEditLast = useCallback(() => {
    const msgs = logRef.current.messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.authorDevice === selfId && !m.deleted && m.body.kind === 'text') {
        setEditingId(m.id)
        return
      }
    }
  }, [selfId])

  // ------------------------------------------------------------------ toast
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)
  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 4000)
  }, [])
  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    },
    [],
  )

  // -------------------------------------------------------------- drag-drop
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)

  const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files')

  const handleDropFiles = useCallback(
    async (files: File[]): Promise<void> => {
      // A dropped diagram opens the editor instead of being shared as a file:
      // a `.excalidraw` scene, or a PNG/SVG exported with "embed scene". Only
      // when it is the single dropped file — a folder-full of screenshots is
      // still a folder-full of screenshots.
      if (files.length === 1) {
        const scene = await sniffDroppedDiagram(files[0]).catch(() => null)
        if (scene) {
          useStore.getState().openDiagramEditor({
            conv,
            mode: 'edit',
            title: '',
            scene: null,
            importFile: { name: scene.name, base64: scene.base64 },
          })
          return
        }
      }
      const attachments: AttachDraft[] = []
      for (const f of files) {
        try {
          attachments.push(await buildAttachment(f))
        } catch {
          /* unreadable file — skip it */
        }
      }
      if (attachments.length === 0) return
      try {
        await useStore.getState().send(conv, { text: '', kind: 'text', attachments })
      } catch (err) {
        showToast(
          String(err).includes('files-not-ready')
            ? 'File sharing lands in the next build'
            : 'Sharing failed — will retry when the folder is back',
        )
      }
    },
    [conv, showToast],
  )

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        position: 'relative',
        background: 'var(--bg-app)',
      }}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        const files = Array.from(e.dataTransfer.files)
        if (files.length > 0) void handleDropFiles(files)
      }}
    >
      <style>{CHAT_CSS}</style>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <MessageList
          key={conv}
          conv={conv}
          log={log}
          loaded={loaded}
          selfId={selfId}
          anchorRead={anchor.conv === conv ? anchor.read : ''}
          editingId={editingId}
          chipOf={chipOf}
          nameOf={nameOf}
          getMessage={getMessage}
          onReply={(id) => {
            setReplyToId(id)
            composerRef.current?.focus()
          }}
          onEditStart={setEditingId}
          onEditDone={() => setEditingId(null)}
        />
      </div>

      <TypingLane conv={conv} selfId={selfId} nameOf={nameOf} />

      <div style={{ padding: '0 16px 14px', flexShrink: 0 }}>
        <Composer
          conv={conv}
          label={label}
          replyTarget={replyToId ? (getMessage(replyToId) ?? null) : null}
          onClearReply={() => setReplyToId(null)}
          onEditLast={onEditLast}
          apiRef={composerRef}
        />
      </div>

      {dragging && <DropOverlay label={label} />}

      {toast && (
        <div
          className="sem-jump"
          role="status"
          style={{
            position: 'absolute',
            bottom: 96,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 35,
            background: 'var(--bg-raised)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--r-full)',
            boxShadow: 'var(--elev-3)',
            padding: '7px 14px',
            fontSize: 12.5,
            color: 'var(--text-1)',
            whiteSpace: 'nowrap',
          }}
        >
          {toast}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function DropOverlay({ label }: { label: string }) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 8,
        zIndex: 30,
        borderRadius: 12,
        border: '2px solid var(--accent)',
        background: 'var(--accent-soft)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        pointerEvents: 'none',
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
      }}
    >
      <span
        className="sem-bob-glyph"
        style={{
          color: 'var(--accent-text)',
          display: 'inline-flex',
          animation: 'sem-bob 1.6s ease-in-out infinite',
        }}
      >
        <UploadIcon size={48} />
      </span>
      <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-1)' }}>Share with {label}</div>
      <div style={{ fontSize: 13, color: 'var(--text-3)' }}>visible to everyone in this conversation</div>
    </div>
  )
}
