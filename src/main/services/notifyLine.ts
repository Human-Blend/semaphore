// What an OS notification says, as a pure function of the conversation kind and
// the preview setting. Extracted from ChatService.maybeNotify (1.2) because
// this is the part with the interesting matrix — three conversation kinds times
// previews on/off — and none of it needs a window, a roster, or Electron.
//
// Everything the caller cannot supply from the payload alone (the display name,
// the channel or group name, the body preview) arrives as a string, so this file
// never has to know how a message body turns into one line.

export type NotifyConvKind = 'chan' | 'dm' | 'grp'

export interface NotifyLineInput {
  kind: NotifyConvKind
  /** Display name of the author, already resolved (or a fallback like "Someone"). */
  who: string
  /** Channel or group name. Unused for a DM, and optional everywhere. */
  convName?: string | null
  /** `SettingsView.notifyPreviews` — off means no content leaves the app. */
  previews: boolean
  /** One line of the message body. Only ever used when `previews` is on. */
  snippet: string
}

export interface NotifyLine {
  title: string
  body: string
}

/**
 * With previews off, nothing about the message — not the author, not the
 * conversation, not a word of the text — reaches the notification: the title is
 * the app's name and the body says only that something arrived. A DM says so
 * because "someone messaged you directly" is the one thing that changes whether
 * people reach for the machine; a private group deliberately does not say
 * "direct message", because it isn't one.
 */
export function notifyLineFor(input: NotifyLineInput): NotifyLine {
  const { kind, who, convName, previews, snippet } = input
  if (!previews) {
    return { title: 'Chat', body: kind === 'dm' ? 'New direct message' : 'New message' }
  }
  const title =
    kind === 'grp'
      ? `${who} in 🔒 ${convName || 'private group'}`
      : kind === 'dm'
        ? who
        : `${who} in #${convName || 'channel'}`
  return { title, body: snippet }
}
