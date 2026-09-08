import { useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import java from 'highlight.js/lib/languages/java'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import sql from 'highlight.js/lib/languages/sql'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import { CheckIcon, CopyIcon } from './icons'
import './content.css'

// Spec §4.4 — code blocks: r-lg container on --bg-code, 32px header with
// language chip + line count + copy, >18 lines collapses to 14 with a fade.

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('java', java)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('c', c)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('csharp', csharp)
hljs.registerLanguage('json', json)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('css', css)

const COMMON_LANGS = [
  'javascript', 'typescript', 'python', 'java', 'go', 'rust', 'c', 'cpp', 'csharp',
  'json', 'bash', 'sql', 'xml', 'css',
]

/** Short display aliases for the language chip. */
const LANG_ALIAS: Record<string, string> = {
  javascript: 'js',
  typescript: 'ts',
  python: 'py',
  csharp: 'c#',
  xml: 'html',
  bash: 'sh',
}

const ALIAS_TO_LANG: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rs: 'rust',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  html: 'xml',
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const COLLAPSE_THRESHOLD = 18
const COLLAPSED_LINES = 14
const CODE_LINE_H = 20

export function CodeBlock({ text, lang }: { text: string; lang: string | null }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { language, html } = useMemo(() => {
    const normalized = lang ? (ALIAS_TO_LANG[lang.toLowerCase()] ?? lang.toLowerCase()) : null
    if (normalized && hljs.getLanguage(normalized)) {
      return {
        language: normalized,
        html: hljs.highlight(text, { language: normalized, ignoreIllegals: true }).value,
      }
    }
    const auto = hljs.highlightAuto(text.slice(0, 2000), COMMON_LANGS)
    if (auto.language && (auto.relevance ?? 0) >= 5) {
      return {
        language: auto.language,
        html: hljs.highlight(text, { language: auto.language, ignoreIllegals: true }).value,
      }
    }
    return { language: null, html: escapeHtml(text) }
  }, [text, lang])

  const lineCount = useMemo(() => text.split('\n').length, [text])
  const collapsible = lineCount > COLLAPSE_THRESHOLD
  const collapsed = collapsible && !expanded

  const copy = (): void => {
    void window.bridge.app.copyText(text).catch(() => {})
    setCopied(true)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1500)
  }

  const chipLabel = language ? (LANG_ALIAS[language] ?? language) : 'text'

  return (
    <div
      className="sem-code"
      style={{
        borderRadius: 'var(--r-lg)',
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-code)',
        overflow: 'hidden',
        maxWidth: '100%',
      }}
    >
      {/* Header bar — 32px */}
      <div
        style={{
          height: 32,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 6px 0 10px',
          borderBottom: '1px solid var(--border-subtle)',
          userSelect: 'none',
        }}
      >
        <span
          title={language ? `Detected language: ${language}` : 'Plain text'}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            fontWeight: 500,
            lineHeight: '18px',
            padding: '0 6px',
            borderRadius: 'var(--r-xs)',
            background: 'var(--accent-soft)',
            color: 'var(--accent-text)',
            textTransform: 'lowercase',
          }}
        >
          {chipLabel}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-ui)' }}>
          {lineCount} {lineCount === 1 ? 'line' : 'lines'}
        </span>
        {collapsible && expanded && (
          <button
            onClick={() => setExpanded(false)}
            title="Collapse code block"
            aria-label="Collapse code block"
            style={headerBtnStyle}
          >
            Collapse
          </button>
        )}
        <button
          onClick={copy}
          title="Copy code"
          aria-label="Copy code"
          style={{
            ...headerBtnStyle,
            color: copied ? 'var(--success)' : 'var(--text-2)',
          }}
        >
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {/* Body */}
      <div
        style={{
          position: 'relative',
          maxHeight: collapsed ? COLLAPSED_LINES * CODE_LINE_H + 10 : undefined,
          overflow: collapsed ? 'hidden' : undefined,
        }}
      >
        <pre>
          <code dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
        {collapsed && (
          <>
            <div className="sem-code-fade" />
            <button
              onClick={() => setExpanded(true)}
              title="Show the full code block"
              aria-label={`Show ${lineCount - COLLAPSED_LINES} more lines`}
              style={{
                position: 'absolute',
                bottom: 8,
                left: '50%',
                transform: 'translateX(-50%)',
                height: 24,
                padding: '0 12px',
                display: 'inline-flex',
                alignItems: 'center',
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--r-full)',
                background: 'var(--bg-raised)',
                color: 'var(--text-1)',
                fontSize: 12,
                fontWeight: 500,
                fontFamily: 'var(--font-ui)',
                cursor: 'pointer',
                boxShadow: 'var(--elev-1)',
              }}
            >
              Show {lineCount - COLLAPSED_LINES} more lines
            </button>
          </>
        )}
      </div>
    </div>
  )
}

const headerBtnStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  height: 22,
  padding: '0 7px',
  border: 'none',
  borderRadius: 'var(--r-xs)',
  background: 'transparent',
  color: 'var(--text-2)',
  fontSize: 11,
  fontWeight: 500,
  fontFamily: 'var(--font-ui)',
  cursor: 'pointer',
} as const
