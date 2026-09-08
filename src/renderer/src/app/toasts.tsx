import { create } from 'zustand'
import { IconBolt, IconCheck, IconInfo, IconWarn } from './icons'

// Lightweight in-app toast rail (top-right). Owned by the shell slice; other
// shell modules call toast(text, tone).

export type ToastTone = 'info' | 'success' | 'danger' | 'flare'

interface ToastItem {
  id: number
  text: string
  tone: ToastTone
}

let nextId = 1

const useToastStore = create<{
  list: ToastItem[]
  push(text: string, tone: ToastTone): void
  dismiss(id: number): void
}>((set) => ({
  list: [],
  push(text, tone) {
    const id = nextId++
    set((s) => ({ list: [...s.list.slice(-2), { id, text, tone }] }))
    window.setTimeout(() => set((s) => ({ list: s.list.filter((t) => t.id !== id) })), 5000)
  },
  dismiss(id) {
    set((s) => ({ list: s.list.filter((t) => t.id !== id) }))
  },
}))

export function toast(text: string, tone: ToastTone = 'info') {
  useToastStore.getState().push(text, tone)
}

const TONE_COLOR: Record<ToastTone, string> = {
  info: 'var(--text-2)',
  success: 'var(--success)',
  danger: 'var(--danger)',
  flare: 'var(--flare)',
}

function ToneIcon({ tone }: { tone: ToastTone }) {
  const style = { color: TONE_COLOR[tone], flexShrink: 0 }
  return (
    <span style={style}>
      {tone === 'success' && <IconCheck size={16} />}
      {tone === 'danger' && <IconWarn size={16} />}
      {tone === 'flare' && <IconBolt size={16} />}
      {tone === 'info' && <IconInfo size={16} />}
    </span>
  )
}

export function Toasts() {
  const list = useToastStore((s) => s.list)
  const dismiss = useToastStore((s) => s.dismiss)
  if (!list.length) return null
  return (
    <div
      style={{
        position: 'fixed',
        top: 52,
        right: 16,
        zIndex: 90,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: 280,
      }}
    >
      {list.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          title="Dismiss"
          aria-label={`Dismiss notification: ${t.text}`}
          className="sem-frost"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            borderRadius: 'var(--r-lg)',
            border: '1px solid var(--border-subtle)',
            boxShadow: 'var(--elev-2)',
            color: 'var(--text-1)',
            fontSize: 13,
            fontFamily: 'var(--font-ui)',
            textAlign: 'left',
            cursor: 'pointer',
            animation: 'sem-toast-in var(--t-base) var(--ease-pop)',
          }}
        >
          <ToneIcon tone={t.tone} />
          <span style={{ lineHeight: '17px' }}>{t.text}</span>
        </button>
      ))}
    </div>
  )
}
