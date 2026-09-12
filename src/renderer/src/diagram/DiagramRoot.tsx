// Armed HERE, on the startup path, and not inside the lazy chunk: ESM
// evaluates a chunk's imports before the chunk's own body, so a side-effect
// import sitting *inside* DiagramEditor runs AFTER Excalidraw's module has
// already built its font registry — too late, and every face then carries only
// the esm.sh fallback URL that the CSP blocks. Verified the hard way.
import './assets'
import { Suspense, lazy } from 'react'
import { useStore } from '@/store'
import { Spinner } from '@/ui/atoms'

// The mount point for the diagram editor, and the lazy boundary in front of it.
//
// AppShell renders this on every launch, so it must stay cheap: it imports the
// store and nothing else. `lazy()` does not fetch anything until the element is
// actually rendered, which only happens once `store.diagramEditor` is set — so
// a session that never draws never pays for Excalidraw's ~1 MB chunk.

const Editor = lazy(() => import('./DiagramEditor'))

export function DiagramRoot() {
  const slot = useStore((s) => s.diagramEditor)
  if (!slot) return null
  // Which board this is: the session for a join, the seed diagram for a start.
  const liveId = slot.live ? (slot.live.kind === 'join' ? slot.live.sessionId : (slot.live.boardId ?? '')) : ''
  return (
    <Suspense fallback={<EditorLoading />}>
      {/* Keyed so switching conversations/diagrams remounts with fresh initial
          data — and, since 1.3, so that joining a different live session is a
          new editor rather than a second session inside the old one. The start
          case needs its `boardId` in the key for the same reason: Collaborate on
          a second diagram has the same conv/mode/kind as the first, so without
          it React kept the mounted editor (and its scene, and its session) and
          the click did nothing at all. */}
      <Editor key={`${slot.conv}:${slot.replyTo ?? ''}:${slot.mode}:${slot.live?.kind ?? ''}:${liveId}`} slot={slot} />
    </Suspense>
  )
}

function EditorLoading() {
  return (
    <div
      role="status"
      aria-label="Opening the diagram editor"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        background: 'var(--bg-app)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        color: 'var(--text-3)',
        fontSize: 13,
      }}
    >
      <Spinner size={18} />
      Opening the diagram editor…
    </div>
  )
}
