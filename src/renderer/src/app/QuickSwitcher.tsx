import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { ConvId } from '@shared/types'
import { useStore, selfOf } from '@/store'
import { Avatar, identityHue } from '@/ui/atoms'
import { modKey, truncate } from './chrome'
import { IconSearch } from './icons'
import { openDm } from './dm'

// Sidebar quick switcher (spec §2.2.2): ⌘K/Ctrl-K focuses it; fuzzy-matches
// channels and people; ↑↓ navigate, ⏎ opens, Esc dismisses.

interface Item {
  key: string
  kind: 'channel' | 'person'
  label: string
  sub: string
  conv?: ConvId
  peerDeviceId?: string
  score: number
}

function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let qi = 0
  let score = 0
  let last = -2
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      score += last === i - 1 ? 3 : 1
      if (i === 0) score += 2
      last = i
      qi++
    }
  }
  return qi === q.length ? score - t.length * 0.01 : null
}

export default function QuickSwitcher() {
  const channels = useStore((s) => s.channels)
  const presence = useStore((s) => s.presence)
  const boot = useStore((s) => s.boot)
  const setActiveConv = useStore((s) => s.setActiveConv)
  const self = selfOf(boot)

  const [q, setQ] = useState('')
  const [focused, setFocused] = useState(false)
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const items = useMemo<Item[]>(() => {
    if (!q.trim()) return []
    const out: Item[] = []
    for (const ch of channels) {
      const s = fuzzyScore(q, ch.name)
      if (s !== null)
        out.push({ key: `c:${ch.conv}`, kind: 'channel', label: ch.name, sub: ch.topic || 'channel', conv: ch.conv, score: s + 0.5 })
    }
    for (const p of presence) {
      if (p.deviceId === self?.deviceId) continue
      const s = fuzzyScore(q, p.name) ?? fuzzyScore(q, p.hostname)
      if (s !== null)
        out.push({
          key: `p:${p.deviceId}`,
          kind: 'person',
          label: p.name,
          sub: `${p.hostname} · ${p.state}`,
          peerDeviceId: p.deviceId,
          score: s,
        })
    }
    out.sort((a, b) => b.score - a.score)
    return out.slice(0, 8)
  }, [q, channels, presence, self?.deviceId])

  useEffect(() => {
    setSel(0)
  }, [q])

  function openItem(it: Item) {
    if (it.kind === 'channel' && it.conv) setActiveConv(it.conv)
    else if (it.peerDeviceId) void openDm(it.peerDeviceId)
    setQ('')
    inputRef.current?.blur()
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(s + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      const it = items[sel]
      if (it) openItem(it)
    } else if (e.key === 'Escape') {
      setQ('')
      inputRef.current?.blur()
    }
  }

  const open = focused && items.length > 0

  return (
    <div style={{ position: 'relative', padding: '8px 8px 4px' }}>
      <div style={{ position: 'relative' }}>
        <span
          style={{
            position: 'absolute',
            left: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--text-3)',
            pointerEvents: 'none',
          }}
        >
          <IconSearch size={14} />
        </span>
        <input
          ref={inputRef}
          className="sem-input"
          style={{ paddingLeft: 28, paddingRight: 38 }}
          placeholder="Jump to…"
          aria-label={`Quick switcher — press ${modKey}K`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            right: 6,
            top: '50%',
            transform: 'translateY(-50%)',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            fontWeight: 500,
            color: 'var(--text-3)',
            background: 'var(--bg-raised)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--r-xs)',
            padding: '1px 5px',
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          {modKey}K
        </span>
      </div>

      {open && (
        <div
          role="listbox"
          aria-label="Quick switcher results"
          className="sem-frost"
          style={{
            position: 'absolute',
            top: 42,
            left: 8,
            right: 8,
            zIndex: 60,
            borderRadius: 'var(--r-lg)',
            border: '1px solid var(--border-subtle)',
            boxShadow: 'var(--elev-2)',
            overflow: 'hidden',
            padding: 4,
            animation: 'sem-pop var(--t-fast) var(--ease-standard)',
          }}
        >
          {items.map((it, i) => (
            <button
              key={it.key}
              role="option"
              aria-selected={i === sel}
              title={it.kind === 'channel' ? `Open #${it.label}` : `Message ${it.label}`}
              className="sem-row"
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                openItem(it)
              }}
              style={{
                width: '100%',
                height: 34,
                gap: 10,
                padding: '0 8px',
                borderRadius: 'var(--r-sm)',
                background: i === sel ? 'var(--accent-soft)' : 'transparent',
              }}
            >
              {it.kind === 'channel' ? (
                <span
                  aria-hidden="true"
                  style={{
                    width: 20,
                    textAlign: 'center',
                    fontWeight: 600,
                    fontSize: 14,
                    color: identityHue(it.label),
                    filter: 'saturate(0.6)',
                    flexShrink: 0,
                  }}
                >
                  #
                </span>
              ) : (
                <Avatar name={it.label} size={20} />
              )}
              <span style={{ ...truncate, color: 'var(--text-1)', fontSize: 13, flex: 1, minWidth: 0 }}>{it.label}</span>
              <span style={{ ...truncate, color: 'var(--text-3)', fontSize: 11, maxWidth: 110 }}>{it.sub}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
