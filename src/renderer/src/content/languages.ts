// The code-block language table (plan §0 row 6 / D1): single source of truth
// for the composer's language chip, the paste-as-code chip (which just reuses
// whatever the chip is currently set to) and `CodeBlock`'s explicit-language
// badge + "is this hljs id actually registered" test. 22 hljs grammars, plus
// the "Plain text" sentinel (explicit, never auto-detected) and Auto-detect
// (null — `draft.lang` stays null and `CodeBlock` falls back to
// `hljs.highlightAuto` under the existing relevance gate).

export interface LangOption {
  /** hljs grammar id, the `PLAIN_TEXT_ID` sentinel, or null for Auto-detect. */
  id: string | null
  label: string
}

/** Explicit "no syntax highlighting" — distinct from Auto-detect (`id: null`):
 * this must never fall through to `hljs.highlightAuto`. */
export const PLAIN_TEXT_ID = 'plaintext'

export const CODE_LANGUAGES: LangOption[] = [
  { id: 'typescript', label: 'TypeScript' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'python', label: 'Python' },
  { id: 'java', label: 'Java' },
  { id: 'csharp', label: 'C#' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'kotlin', label: 'Kotlin' },
  { id: 'swift', label: 'Swift' },
  { id: 'php', label: 'PHP' },
  { id: 'ruby', label: 'Ruby' },
  { id: 'sql', label: 'SQL' },
  { id: 'json', label: 'JSON' },
  { id: 'yaml', label: 'YAML' },
  { id: 'bash', label: 'Bash' },
  { id: 'powershell', label: 'PowerShell' },
  { id: 'xml', label: 'HTML/XML' },
  { id: 'css', label: 'CSS' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'dockerfile', label: 'Dockerfile' },
  { id: PLAIN_TEXT_ID, label: 'Plain text' },
  { id: null, label: 'Auto-detect' },
]

export const DEFAULT_LANG_ID = 'typescript'

/** The hljs grammar ids the table expects `CodeBlock` to have registered —
 * excludes the plain-text sentinel and Auto-detect's null. */
export const HLJS_LANG_IDS = CODE_LANGUAGES.map((l) => l.id).filter(
  (id): id is string => id !== null && id !== PLAIN_TEXT_ID,
)

/** Display label by id, including the plain-text sentinel — used for the
 * CodeBlock badge so it reads "TypeScript", not the raw hljs id. */
export const LABEL_BY_ID: Record<string, string> = Object.fromEntries(
  CODE_LANGUAGES.filter((l): l is { id: string; label: string } => l.id !== null).map((l) => [l.id, l.label]),
)

// ---------------------------------------------------------------------------
// Composer's remembered choice (localStorage — a sticky user preference, not
// reset per-conversation like the rest of the composer's draft state).

const STORAGE_KEY = 'sem-composer-code-lang'

export function readStoredLang(): string | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return DEFAULT_LANG_ID
    if (raw === 'null') return null
    return CODE_LANGUAGES.some((l) => l.id === raw) ? raw : DEFAULT_LANG_ID
  } catch {
    return DEFAULT_LANG_ID
  }
}

export function writeStoredLang(id: string | null): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id === null ? 'null' : id)
  } catch {
    /* localStorage unavailable (private mode, disabled) — the in-memory choice still works this session */
  }
}
