// MUST be the first import: it arms window.EXCALIDRAW_ASSET_PATH before
// Excalidraw's font registry is evaluated, which is the difference between
// self-hosted fonts and a blocked CDN request. See assets.ts.
import './assets'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Excalidraw, exportToBlob, exportToSvg, loadFromBlob, restoreLibraryItems, serializeAsJSON } from '@excalidraw/excalidraw'
import type { BinaryFiles, ExcalidrawImperativeAPI, LibraryItems } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement, NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import '@excalidraw/excalidraw/index.css'
import { DIAGRAM } from '@shared/constants'
import { DIAGRAM_DEFAULT_TITLE, cleanTitle, diagramFileStem } from '@shared/diagram'
import { useStore } from '@/store'
import { Spinner } from '@/ui/atoms'
import { ConfirmDialog } from '@/app/ChannelMenu'
import { CloseIcon, DownloadIcon } from '@/content/icons'
import { clearDraft, draftSlotOf, readDraft, writeDraft } from './drafts'
import { fetchBundledLibraries, libraryPayload } from './libraries'
import { bytesToBase64, planDiagramSend, sceneSignature } from './scene'
import { sanitizeScene } from './sanitize'
import type { DiagramEditorState } from './state'

// The full-window diagram editor (1.2). Same overlay grammar as the media
// lightbox — fixed inset 0, its own chrome strip, Esc closes — but it owns the
// keyboard while it is up, because Excalidraw's own shortcuts live underneath.
//
// This module is the lazy chunk: importing it pulls in Excalidraw. Nothing may
// import it statically except DiagramRoot's `lazy()`.

const SAVE_DEBOUNCE_MS = 800

type Busy = null | 'sending' | 'exporting' | 'importing'

export default function DiagramEditor({ slot }: { slot: DiagramEditorState }) {
  const settings = useStore((s) => s.settings)
  const channels = useStore((s) => s.channels)
  const groups = useStore((s) => s.groups)
  const send = useStore((s) => s.send)
  const close = useCallback(() => useStore.getState().openDiagramEditor(null), [])

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const [title, setTitle] = useState(() => slot.title || DIAGRAM_DEFAULT_TITLE)
  const [busy, setBusy] = useState<Busy>(null)
  const [note, setNote] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  /** Set once the close confirm is up; `kept` is whether the draft really made it to disk. */
  const [closing, setClosing] = useState<{ kept: boolean } | null>(null)
  const dirty = useRef(false)
  /** Fingerprint of the element array as of the last real edit — see `scheduleSave`. */
  const sig = useRef('')
  const saveTimer = useRef<number | null>(null)

  // "New diagram here" and "edit a copy of that message" are two different
  // pieces of unsent work; they used to share one draft key per conversation,
  // so opening the second silently overwrote the first.
  const slotKey = draftSlotOf(slot)

  const viewOnly = slot.mode === 'view'
  const theme = settings?.theme === 'light' ? 'light' : 'dark'

  const convLabel = useMemo(() => {
    const ch = channels.find((c) => c.conv === slot.conv)
    if (ch) return `#${ch.name}`
    const g = groups.find((x) => x.conv === slot.conv)
    if (g) return `🔒 ${g.name}`
    return 'this conversation'
  }, [channels, groups, slot.conv])

  const flash = useCallback((msg: string) => {
    setNote(msg)
    window.setTimeout(() => setNote((n) => (n === msg ? null : n)), 3200)
  }, [])

  // ---------------------------------------------------------------- initial
  // Resolved once (the component is keyed on the slot, so a new diagram is a
  // new mount): this slot's autosaved draft, else the scene it was opened with.
  /** True when a draft replaced the scene the editor was opened with — say so, once. */
  const restoredDraft = useRef(false)
  const initialData = useMemo(() => {
    // An unsent draft for THIS slot wins over the scene the slot was opened
    // with: it is the newer version of the same work, and the close dialog
    // promised it would come back.
    const restored = viewOnly ? null : readDraft(slot.conv, slotKey)
    const json = restored?.scene ?? slot.scene ?? null
    if (restored && !slot.title) setTitle(restored.title || DIAGRAM_DEFAULT_TITLE)
    const parsed = json ? safeParse(json) : null
    const elements = (parsed?.elements ?? []) as ExcalidrawElement[]
    sig.current = sceneSignature(elements)
    restoredDraft.current = restored !== null && slot.scene !== null
    return {
      elements,
      appState: { viewBackgroundColor: '#ffffff', ...(parsed?.appState ?? {}) },
      files: (parsed?.files ?? {}) as BinaryFiles,
      scrollToContent: true,
      libraryItems: loadBundledLibraryItems(),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (restoredDraft.current) flash('Restored your unsent draft of this diagram')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ------------------------------------------------------------- autosave
  /** Write the draft right now; `false` means it could not be kept (too big, or no quota). */
  const saveDraftNow = useCallback((): boolean => {
    const api = apiRef.current
    if (!api) return false
    return writeDraft(slot.conv, slotKey, {
      title,
      scene: serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), 'local'),
    })
  }, [slot.conv, slotKey, title])

  //
  // `onChange` fires for everything Excalidraw does — pan, zoom, pick a tool,
  // move the pointer with one armed — so it cannot mean "edited". Only a change
  // in the element array itself counts; without that, closing a diagram nobody
  // touched asked "are you sure?". A call with no elements (the title input) is
  // always an edit.
  const scheduleSave = useCallback(
    (elements?: readonly { version?: number; versionNonce?: number }[]) => {
      if (viewOnly) return
      if (elements) {
        const next = sceneSignature(elements)
        if (next === sig.current) return
        sig.current = next
      }
      dirty.current = true
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(saveDraftNow, SAVE_DEBOUNCE_MS)
    },
    [saveDraftNow, viewOnly],
  )

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    },
    [],
  )

  const tryClose = useCallback(() => {
    if (viewOnly || !dirty.current) {
      close()
      return
    }
    // Save first, then say what actually happened. The old wording promised the
    // work was kept even when the draft was too big for localStorage to hold —
    // which is exactly the case where the person needed to be told.
    setClosing({ kept: saveDraftNow() })
  }, [close, saveDraftNow, viewOnly])

  // Esc closes the editor's own chrome — but NOT when the canvas has it.
  //
  // Excalidraw owns Escape inside its host: it leaves a text element being
  // typed, drops a selection, closes the shape-library panel. Swallowing it at
  // the window's capture phase meant every one of those tore the whole editor
  // down instead (behind a confirm, on top of unsent work). So: the confirm
  // first, then the export menu, then — only if the event did not come from
  // inside `.excalidraw` — the editor itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (closing) {
        setClosing(null)
        e.stopPropagation()
        e.preventDefault()
        return
      }
      if (exportOpen) {
        setExportOpen(false)
        e.stopPropagation()
        return
      }
      const target = e.target as Element | null
      if (target?.closest?.('.excalidraw')) return // Excalidraw's Escape, not ours
      e.stopPropagation()
      e.preventDefault()
      tryClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [closing, exportOpen, tryClose])

  // ----------------------------------------------------------------- send
  const doSend = useCallback(async () => {
    const api = apiRef.current
    if (!api || busy) return
    const elements = api.getSceneElements()
    if (elements.length === 0) {
      flash('Nothing to send — the canvas is empty')
      return
    }
    setBusy('sending')
    try {
      const appState = api.getAppState()
      const files = api.getFiles()
      const json = serializeAsJSON(elements, appState, files, 'local')
      const png = await exportToBlob({
        elements: elements as NonDeletedExcalidrawElement[],
        appState: { ...appState, exportBackground: true, exportWithDarkMode: false },
        files,
        mimeType: 'image/png',
        maxWidthOrHeight: 1024,
      })
      const bounds = boundsOf(elements)
      const plan = await planDiagramSend(
        title,
        { json, png, w: bounds.w, h: bounds.h, elements: elements.length },
        { replyTo: slot.replyTo },
      )
      await send(slot.conv, plan.draft)
      clearDraft(slot.conv, slotKey)
      dirty.current = false
      close()
    } catch (err) {
      const msg = String(err)
      flash(
        msg.includes('queued')
          ? 'Queued — it will send when the folder is back'
          : msg.includes('diagram-too-large')
            ? 'This diagram is too big to send — try splitting it'
            : 'Could not send the diagram',
      )
      setBusy(null)
    }
  }, [busy, close, flash, send, slot.conv, slot.replyTo, slotKey, title])

  // --------------------------------------------------------------- export
  const doExport = useCallback(
    async (kind: 'png' | 'svg' | 'excalidraw') => {
      const api = apiRef.current
      setExportOpen(false)
      if (!api || busy) return
      setBusy('exporting')
      try {
        const elements = api.getSceneElements()
        const appState = api.getAppState()
        const files = api.getFiles()
        const stem = diagramFileStem(title)
        if (kind === 'excalidraw') {
          const json = serializeAsJSON(elements, appState, files, 'local')
          await save(`${stem}${DIAGRAM.ext}`, new TextEncoder().encode(json), DIAGRAM.mime)
        } else if (kind === 'png') {
          const blob = await exportToBlob({
            elements: elements as NonDeletedExcalidrawElement[],
            appState: { ...appState, exportBackground: true, exportWithDarkMode: false },
            files,
            mimeType: 'image/png',
          })
          await save(`${stem}.png`, new Uint8Array(await blob.arrayBuffer()), 'image/png')
        } else {
          const svg = await exportToSvg({
            elements: elements as NonDeletedExcalidrawElement[],
            appState: { ...appState, exportBackground: true, exportWithDarkMode: false },
            files,
          })
          await save(`${stem}.svg`, new TextEncoder().encode(svg.outerHTML), 'image/svg+xml')
        }
      } catch (err) {
        flash(String(err).includes('not-implemented') ? 'File service lands in the next build' : 'Export failed')
      } finally {
        setBusy(null)
      }
    },
    [busy, flash, title],
  )

  // --------------------------------------------------------------- import
  const applyFile = useCallback(
    async (name: string, base64: string): Promise<void> => {
      const api = apiRef.current
      if (!api) return
      const loaded = await loadSceneFile(name, base64)
      api.updateScene({ elements: loaded.elements, appState: { ...api.getAppState(), ...loaded.appState } })
      if (loaded.files) api.addFiles(Object.values(loaded.files))
      if (!slot.title) setTitle(cleanTitle(name.replace(/\.(excalidraw|png|svg)$/i, '')))
      scheduleSave()
    },
    [scheduleSave, slot.title],
  )

  const importFailed = useCallback(
    (err: unknown) =>
      flash(
        String(err).includes('file-too-large')
          ? 'That file is too big to import'
          : 'That file does not carry an Excalidraw scene',
      ),
    [flash],
  )

  const doImport = useCallback(async () => {
    if (!apiRef.current || busy) return
    setBusy('importing')
    try {
      const picked = await window.bridge.files.pickFile({
        title: 'Import a diagram',
        filters: [
          { name: 'Diagrams', extensions: ['excalidraw', 'png', 'svg'] },
          { name: 'All files', extensions: ['*'] },
        ],
      })
      if (!picked) return
      await applyFile(picked.name, picked.bytes)
    } catch (err) {
      importFailed(err)
    } finally {
      setBusy(null)
    }
  }, [applyFile, busy, importFailed])

  // A drop or an "Import diagram…" from the composer hands the editor its file
  // up front; the Excalidraw API only exists after the first render, so this
  // waits for the mount rather than doing it in the initial data.
  const autoRan = useRef(false)
  useEffect(() => {
    if (autoRan.current) return
    autoRan.current = true
    if (slot.importFile) {
      void applyFile(slot.importFile.name, slot.importFile.base64).catch(importFailed)
    } else if (slot.autoImport) {
      void doImport()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ------------------------------------------------------------------ view
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={viewOnly ? `Diagram: ${title}` : `Diagram editor: ${title}`}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        background: 'var(--bg-app)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header
        style={{
          height: 52,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 12px 0 16px',
          borderBottom: '1px solid var(--border-subtle)',
          background: 'var(--bg-panel)',
        }}
      >
        <span aria-hidden style={{ fontSize: 15 }}>
          📐
        </span>
        <input
          value={title}
          readOnly={viewOnly}
          onChange={(e) => {
            setTitle(e.target.value)
            scheduleSave()
          }}
          aria-label="Diagram title"
          placeholder={DIAGRAM_DEFAULT_TITLE}
          style={{
            width: 260,
            padding: '5px 8px',
            border: '1px solid transparent',
            borderRadius: 'var(--r-sm)',
            background: viewOnly ? 'transparent' : 'var(--bg-input)',
            color: 'var(--text-1)',
            fontSize: 13,
            fontWeight: 600,
            fontFamily: 'var(--font-ui)',
            outline: 'none',
          }}
        />
        <span style={{ flex: 1 }} />

        {note && <span style={{ fontSize: 12, color: 'var(--warning)', whiteSpace: 'nowrap' }}>{note}</span>}

        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setExportOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={exportOpen}
            title="Export this diagram to a file"
            style={chromeBtn}
          >
            <DownloadIcon size={13} />
            Export ▾
          </button>
          {exportOpen && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 1 }} onMouseDown={() => setExportOpen(false)} />
              <div
                role="menu"
                className="sem-popover"
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: 6,
                  zIndex: 2,
                  minWidth: 190,
                  padding: 4,
                  background: 'var(--bg-raised)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--r-md)',
                  boxShadow: 'var(--elev-3)',
                }}
              >
                {(
                  [
                    ['png', 'PNG image'],
                    ['svg', 'SVG (vector)'],
                    ['excalidraw', `Scene (${DIAGRAM.ext})`],
                  ] as const
                ).map(([kind, label]) => (
                  <button
                    key={kind}
                    role="menuitem"
                    onClick={() => void doExport(kind)}
                    style={menuItem}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover, var(--bg-panel))')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {!viewOnly && (
          <button onClick={() => void doImport()} title="Open a .excalidraw file (or an image with a scene)" style={chromeBtn}>
            Import…
          </button>
        )}

        {!viewOnly && (
          <button
            onClick={() => void doSend()}
            disabled={busy !== null}
            title={`Send this diagram to ${convLabel}`}
            style={{
              ...chromeBtn,
              border: '1px solid var(--accent)',
              background: 'var(--accent)',
              color: 'var(--on-accent)',
              opacity: busy !== null ? 0.6 : 1,
            }}
          >
            {busy === 'sending' ? <Spinner size={12} /> : null}
            Send to {convLabel}
          </button>
        )}

        {/* Esc closes this too, but only while the canvas doesn't own the key
            — inside it, Escape belongs to Excalidraw. */}
        <button onClick={tryClose} title="Close" aria-label="Close the diagram editor" style={{ ...chromeBtn, padding: '0 8px' }}>
          <CloseIcon size={14} />
        </button>
      </header>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }} className="sem-diagram-host">
        <Excalidraw
          excalidrawAPI={(api) => {
            apiRef.current = api
          }}
          initialData={initialData}
          onChange={(elements) => scheduleSave(elements)}
          theme={theme}
          viewModeEnabled={viewOnly}
          name={title}
          UIOptions={{
            canvasActions: {
              // Everything that would leave the app or hit the network: the
              // header above owns saving, and there is no cloud here.
              saveToActiveFile: false,
              loadScene: false,
              export: false,
              saveAsImage: false,
              toggleTheme: false,
            },
          }}
          autoFocus
          detectScroll={false}
        />
      </div>

      {closing && (
        // Above the editor's own 1100 (it lives inside this overlay's stacking
        // context, so this only has to beat Excalidraw's internal layers).
        <ConfirmDialog
          title="Close this diagram?"
          message={
            closing.kept
              ? 'Your unsent work is kept as a draft — opening the diagram from this conversation again brings it straight back.'
              : 'This drawing could not be saved as a draft (it is too large, or the local store is full), so closing it now loses the unsent work.'
          }
          confirmLabel={closing.kept ? 'Close' : 'Close and lose it'}
          tone={closing.kept ? 'primary' : 'danger'}
          zIndex={1200}
          onConfirm={() => {
            setClosing(null)
            close()
          }}
          onClose={() => setClosing(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

const chromeBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 28,
  padding: '0 10px',
  flexShrink: 0,
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--r-sm)',
  background: 'var(--bg-raised)',
  color: 'var(--text-1)',
  fontSize: 12,
  fontWeight: 600,
  fontFamily: 'var(--font-ui)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const menuItem: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '6px 8px',
  border: 'none',
  borderRadius: 'var(--r-sm)',
  background: 'transparent',
  color: 'var(--text-1)',
  fontSize: 13,
  fontFamily: 'var(--font-ui)',
  cursor: 'pointer',
}

/**
 * Parse a scene the editor was opened with. Peer-authored documents come
 * through here too ("Open", "Edit a copy"), so it goes through the same
 * sanitizer the tile uses: `files[]` entries pointing at a remote URL are
 * dropped (they would be fetched the moment the canvas drew them) and an
 * absurd element count is refused. Links are NOT stripped here — inside the
 * editor a link is Excalidraw's own feature and a click leaves through
 * `shell.openExternal` like any other message link.
 *
 * `null` on anything unparseable: the editor opens blank rather than crashing.
 */
function safeParse(json: string): { elements?: unknown; appState?: Record<string, unknown>; files?: unknown } | null {
  try {
    return sanitizeScene(JSON.parse(json))
  } catch {
    return null
  }
}

function boundsOf(elements: readonly { x: number; y: number; width: number; height: number; isDeleted?: boolean }[]): {
  w: number
  h: number
} {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of elements) {
    if (el.isDeleted) continue
    minX = Math.min(minX, el.x)
    minY = Math.min(minY, el.y)
    maxX = Math.max(maxX, el.x + el.width)
    maxY = Math.max(maxY, el.y + el.height)
  }
  if (!Number.isFinite(minX)) return { w: 420, h: 320 }
  return { w: Math.max(1, Math.round(maxX - minX)) + 24, h: Math.max(1, Math.round(maxY - minY)) + 24 }
}

/** The bundled starter shapes, merged across files and version formats. */
async function loadBundledLibraryItems(): Promise<LibraryItems> {
  const raws = await fetchBundledLibraries()
  const out: LibraryItems[number][] = []
  for (const raw of raws) {
    try {
      out.push(...restoreLibraryItems(libraryPayload(raw) as never, 'published'))
    } catch {
      // one malformed library must not cost the others
    }
  }
  return out
}

/**
 * Turn picked bytes into a scene. `.excalidraw` is the certain case; a PNG or
 * SVG only works when it was exported with "embed scene", and Excalidraw's own
 * loader is what knows how to dig the payload back out of either.
 */
async function loadSceneFile(name: string, base64: string) {
  const lower = name.toLowerCase()
  const mime = lower.endsWith('.png')
    ? 'image/png'
    : lower.endsWith('.svg')
      ? 'image/svg+xml'
      : DIAGRAM.mime
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const blob = new Blob([bytes as BlobPart], { type: mime })
  return loadFromBlob(blob, null, null)
}

async function save(name: string, bytes: Uint8Array, mime: string): Promise<void> {
  await window.bridge.files.saveBytesAs(name, bytesToBase64(bytes), mime)
}
