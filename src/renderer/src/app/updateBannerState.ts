// The update banner's non-visual rules (1.2), split out so they can be tested
// in the node environment the suite runs in — the component itself needs a DOM.
//
// Two sources can raise a banner for the same version: the signed release
// manifest in `apps/version.json`, and a teammate's beacon claiming they are
// already on it. They are not equivalent — one is verified against the baked
// release key and can hand you the zip, the other is a sentence someone with
// write access to the share can produce — so their dismissals are not
// interchangeable either.

export type UpdateSource = 'manifest' | 'peer'

/**
 * Per-version *and* per-source dismissal. Keying on the version alone meant
 * "remind me later" on the peer rumour also silenced the real, signed banner
 * for that version — permanently, since the key outlives the session.
 */
export const laterKey = (version: string, source: UpdateSource): string => `update-later:${source}:${version}`

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null // private mode / blocked storage
  }
}

export function dismissedFor(version: string, source: UpdateSource): boolean {
  try {
    return store()?.getItem(laterKey(version, source)) === '1'
  } catch {
    return false
  }
}

export function rememberLater(version: string, source: UpdateSource): void {
  try {
    store()?.setItem(laterKey(version, source), '1')
  } catch {
    // quota / private mode — the in-session dismissal still applies
  }
}

/**
 * The signed manifest arriving answers the rumour: whatever the peer banner was
 * told to stop nagging about, the version is now genuinely copyable and gets to
 * speak once.
 */
export function forgetPeerDismissal(version: string): void {
  try {
    store()?.removeItem(laterKey(version, 'peer'))
  } catch {
    // nothing to clear
  }
}

/** A display name off the share is untrusted text, and it sits in a sentence. */
export const MAX_PEER_NAME = 40

export function shortPeerName(name: string | undefined): string {
  const trimmed = (name ?? '').replace(/\s+/g, ' ').trim()
  if (!trimmed) return 'A teammate'
  return trimmed.length > MAX_PEER_NAME ? `${trimmed.slice(0, MAX_PEER_NAME - 1)}…` : trimmed
}

/**
 * The peer variant's wording. Nothing here has been verified against the
 * release key, so it reports a claim and its claimant — never that an update
 * "is available", which is what the manifest banner (and only it) may say.
 */
export function peerSentence(name: string | undefined, version: string): string {
  return `${shortPeerName(name)} says they're on Chat ${version} — no signed build in the apps folder yet.`
}
