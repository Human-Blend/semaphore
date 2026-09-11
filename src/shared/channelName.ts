// Single source of truth for channel-name normalization (1.2). Sidebar.tsx
// (create/rename inputs) and services/channels.ts (folding a `channel-renamed`
// sys event) used to each carry their own copy — `/^#/` vs `/^#+/`, one capped
// at 40 chars and the other not — so the same typed name could pass the
// renderer's check and still come back reshaped once it round-tripped through
// the fold. One function, imported by both.

/** Longest name a channel may fold to. */
export const CHANNEL_NAME_MAX = 40

/**
 * Lower-case, whitespace-collapsed, `#`-stripped, length-capped channel name.
 * `\p{C}` (Unicode general category "Other": control, format, private-use,
 * surrogate, unassigned) is stripped after whitespace is collapsed to dashes,
 * so an ordinary tab/newline still becomes a separator — this only removes
 * characters like bidi override/embedding marks and stray control bytes that
 * could otherwise make a name render misleadingly in the sidebar.
 */
export function normalizeChannelName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/\p{C}/gu, '')
    .replace(/^#+/, '')
    .slice(0, CHANNEL_NAME_MAX)
}
