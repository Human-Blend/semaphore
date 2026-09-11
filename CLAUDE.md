# Chat — agent notes

Electron 44 + React 19 + TS(strict) + Tailwind 4 + zustand. The app's entire
backend is an encrypted shared folder (SMB) — there is no server. Read
`README.md` first; the full reconciled design lives in the approved plan
(`~/.claude/plans/i-want-you-to-compressed-dongarra.md`).

## Iron rules

- **Zero native modules, zero npm crypto deps.** All crypto is `node:crypto`
  (main) / WebCrypto (renderer hot paths). `scripts/check-no-natives.mjs`
  gates every release; `.npmrc` has `ignore-scripts=true`.
- **One writer per file on the share, ever.** Publish = temp-write + rename.
  Never `fs.watch` the share; polling only. Deletes are idempotent.
- **Envelope discipline:** SFC1 records / SFB1 streams with AAD binding to
  `scope|relPath|objectId` — changing a file's path or name breaks decryption
  *by design*. Sign-then-encrypt everywhere (`signRecord`/`verifyRecord`).
- Packaging: `zip` targets only (never `portable` — %TEMP% self-extraction
  reads as malware). macOS keeps explicit ad-hoc `identity: '-'`.
- **Release signing:** `RELEASE_PUBKEY_B64URL` in `services/updates.ts` is baked
  (since 1.1.0) and must never change without a hand-delivered build — clients
  reject manifests signed by anything else. The private half lives only at
  `~/.semaphore-release-key.json`; never commit it, never print it.
- **No macOS Keychain, ever** (`src/main/store/osKeystore.ts`). Keychain
  ACLs bind to the ad-hoc cdhash, so every build re-prompts "Semaphore wants
  to use your confidential information…" and a Deny bricks the profile. On
  macOS the LMK is wrapped under the team passphrase (unlock screen each
  launch); Windows uses DPAPI via `safeStorage` silently.
- Renderer is sandboxed web code; everything crosses the typed bridge in
  `src/shared/bridge.ts` (implemented in `src/preload/index.ts`, handled in
  `src/main/ipc.ts` + `services/*Ipc.ts`).

## Commands

- `npm run typecheck` · `npm test` (unit + two-client protocol integration)
- `npm run dev:a` / `dev:b` — two instances, separate userData profiles
- `node scripts/e2e-drive.mjs` — drives two REAL instances over CDP
  (onboarding → chat → DMs → blobs → beams), needs `npm run build` first
- `npm run dist` — both platform zips; `npm run release` — full gated release

## Machine quirks (this Mac)

- Node 22.11: prefix `NODE_OPTIONS=--experimental-require-module` for vitest
  and `node_modules/electron/install.js` (npm test already does).
- The Claude Code harness exports `ELECTRON_RUN_AS_NODE` — always clear it
  (`env -u ELECTRON_RUN_AS_NODE`) when launching Electron or the packaged app.
- Every macOS launch (dev, E2E, packaged) goes through the passphrase unlock
  screen by design — see the Keychain rule above. Drive it over the bridge
  with `window.bridge.app.unlock(pass)` in scripts.
- BSD `grep` silently matches nothing (empty output, rc 1) on files with
  multibyte characters (`·`, `…`, `→`) under the default locale — use
  `LC_ALL=C grep -an …`.

## Known deferred items (v2 candidates)

In-app passphrase rotation (new epoch + LMK re-wrap; until
then a departing member means a new team folder) · message-content search ·
screen-share audio · blob dedup ·
DM forward-secrecy prekeys · day-bundle compaction for multi-month cold starts
· beam transfers over RTCDataChannel (currently folder-only) · online GIF
search (needs a Giphy/Tenor key; the bundled pack is the offline path) · live
co-editing of diagrams (1.2's "edit a copy → send" is the discussion loop; a
real shared canvas would also fight the share-I/O-budget work) · a member who
*leaves* a group keeps a working current key (only a removal by the owner
rotates — see `GroupService.leave`).

## GIF pack

`node scripts/fetch-gif-pack.mjs` refreshes `resources/gifs-starter/` from
Google's Noto Animated Emoji (CC BY 4.0, committed so builds work offline).
Files over 1.2 MB are skipped — they render at ~160px. The renderer loads them
over the `sfgif://pack/<id>.gif` protocol (`src/main/services/gifProtocol.ts`);
a pack GIF is sent as its `packId`, so it costs zero shared-folder I/O.

## Team conversations (1.1)

`team:` is a third `ConvId` kind alongside `chan:`/`dm:` (guards in
`src/shared/ids.ts`: `isTeamConv`/`isChanConv`/`isDmConv` — use these, never
hand-rolled `startsWith`). Logs live under `<share>/Chat/team/<opaque
token>/events`, one dir per fixed conv (`TEAM_CONV.calendar`,
`TEAM_CONV.prs`); the token is derived (`convToken`), not the conv id, so
`team/` never reveals what's inside from the filename. The janitor never
sweeps `team/` by construction (`SWEEP_EVENT_ROOTS` in
`services/janitor.ts`) — team logs are LWW-materialized, not
compaction-pruned. Event types `cal` (calendar entries) and `prs` (PR
config) ride the same signed/encrypted envelope as chat events but skip
read-cursor bookkeeping. Full design: `docs/features-1.1.md`.

## Splash window (1.1)

`createSplash()` runs in `whenReady` *before* `await controller.init()` and
is never assigned to `mainWindow` — it's a separate `BrowserWindow` torn
down from the main window's `ready-to-show` (after a minimum linger) and
from `before-quit`/a failed `init()`. `scripts/e2e-drive.mjs`'s `connect()`
filters the splash target out by page shape (`typeof window.bridge ===
'object'`), not by title — the splash sets no bridge.

## PR service (1.1)

`prService.ts` talks to Azure DevOps only over Electron's `net.fetch`
(`src/main/services/ado.ts`) — no added deps. The PAT is never logged;
every `AdoError.detail` is redacted (raw token, its base64 form, and its
percent-encoding all scrubbed) before it can reach a toast or a report.
Two secrets keys: `prs-token` (per-device, personal PAT) and `prs-seen`
(team-scoped, pruned to the currently tracked PR keys — cleared along with
the rest of team-scoped secrets on `changeTeamFolder`).

## macOS screen-recording permission

Never check `getMediaAccessStatus('screen')` *before* attempting a capture:
macOS only lists an app under Privacy → Screen Recording once it has tried,
so checking-then-bailing sends people to a pane where Chat isn't listed.
`scripts/after-pack.mjs` strips electron-builder's boilerplate Camera /
Microphone / Audio / Bluetooth usage strings for the same reason — they made
the app show up under Microphone and nowhere else.

## Private groups (1.2)

`grp:` is a fourth `ConvId` kind (`isGrpConv()` in `src/shared/ids.ts`). A
group is just a random 32-byte key; it is never discoverable from the share.
The key is delivered as a `group-invite` notice **inside the owner↔member
DM log** (already E2E, already polled — zero new share I/O, no membership
leak in any filename), and the group's own log lives at an opaque
`groups/<token>/events/`, where `token = base32(HMAC(key1,
HKDF_INFO.grpDirToken))[0:20]` — computable only by someone who already holds
the epoch-1 key, which is why every invite/rekey above epoch 1 carries `key1`
too (see `docs/contract-changes-1.2.md` for why that's wider than the
original contract comment said). Removing a member always rotates the key to
a new epoch (`GroupService.removeMember` in `src/main/services/groups.ts`);
the removal event itself is published *under the new key*, so the removed
device can't read that it happened — which is why the owner also sends it a
`grp` `group-removed` notice over their DM (1.2 review fix), on which that
device drops the group locally. `grp` is a fourth event type carrying the
invite/rekey/removed notices that ride a DM log: they used to be `sys` events,
and a shipped 1.1 client renders an unknown sys kind as a *blank row* in that
DM (its `sysLine` has no default), while a `.grp.e1` filename it cannot parse
is skipped in silence. Same reason `noteOwnEvent` keeps those filenames out of
the DM beacon section's `heads` and in `grpHeads`. A record from a retired epoch,
written by someone no longer in the fold, after the point that epoch was
retired, is refused (`GroupService.staleWriteCut`, called from
`transport/events.ts`'s decrypt path) — history from before the rotation
still opens for everyone, including the removed member's own old messages.
Records under an epoch a reader doesn't hold yet are parked
(`pendingByEpoch`), never quarantined, and replayed once the key arrives.
Roles: the **owner** renames, adds, removes and deletes; a **member** renames
and leaves. Membership is owner-managed end to end because a newcomer's client
only adopts an invite signed by the owner (nothing on the share proves who owns
a group), so both `addMembers` and the `group-members-added` fold refuse a
non-owner. `SWEEP_EVENT_ROOTS` (`services/janitor.ts`) includes `DIR.groups`, so a
deleted group's directory is removed after `RETENTION.deletedConvGraceDays`
exactly like a deleted channel. A team-passphrase holder with no invite sees
only an opaque `groups/<token>` directory and file counts inside it —
nothing about names, members, or content. Full design:
`docs/features-1.2.md` §2.

## Channel rename/delete (1.2)

Both ride the channel's own event log as `sys` events — `channel-renamed`
(`data: { name }`) and `channel-deleted` (`data: {}`) — folded LWW by event
id in `src/main/services/channels.ts` (`foldChannelSys`); `channel.json.e1`
is never rewritten (clients cache it once, forever). A rename after a
delete still folds but can never resurrect the channel: `channelViews()`
omits anything with `deletedAt` set regardless of its folded name. Exactly
one channel per team is fixed (`ChannelMeta.fixed`, set by the bootstrap
`general` channel; teams predating 1.2 fall back to the oldest channel,
ties broken by the lowest `channelId`) and can be neither renamed nor
deleted. The janitor removes a deleted channel's (or group's) directory only
after `RETENTION.deletedConvGraceDays` (3 days) have passed since its
tombstone — the delay is what lets an offline client come back, read the
tombstone, and hide the conversation for itself before the directory is
gone. `channel-renamed` happens to already render correctly on a shipped
1.1.2 client (that literal was already in its `SysPayload.kind` union and
`sysLine()`, just never published by anything in 1.1) — but 1.1.2 has no
fold logic for either kind, so the channel itself never actually renames or
disappears in a 1.1 sidebar.

## Diagrams (1.2)

`@excalidraw/excalidraw@0.18.1` (MIT; chosen over tldraw specifically
because tldraw's license requires a watermark). `scripts/sync-excalidraw-
assets.mjs` copies the dependency's font files into
`src/renderer/public/excalidraw-assets/` (gitignored, derived) so the editor
is fully self-hosted — Excalidraw falls back to an `esm.sh` CDN the CSP
blocks when its asset path is unset. Because `.npmrc` sets
`ignore-scripts=true`, npm's `pre*`/`post*` hooks never run, so this script
is chained **explicitly** into `dev`/`dev:a`/`dev:b`/`build` in
`package.json` (`npm run sync:assets` runs it standalone) — do not rely on a
`preinstall`/`predev` hook to do this, it won't fire.
`src/renderer/src/diagram/assets.ts` sets `window.EXCALIDRAW_ASSET_PATH` to
an absolute URL resolved against `location.href` (not `location.origin`,
which is the literal string `"file://"` in a packaged build) and monkey-
patches the global `FontFace` constructor to strip Excalidraw's hardcoded
`esm.sh` fallback out of every font's `src` list — the library appends that
CDN URL after whatever the asset path yields no matter what, and without the
patch every font issues a second, CSP-blocked network request per glyph
(~230 console errors per editor open, measured). CSP additions in
`src/renderer/index.html`: `worker-src 'self' blob:` and `font-src 'self'
data:` — nothing else was loosened. Bundled `.excalidrawlib` shape libraries
under `src/renderer/src/diagram/libraries/` are verbatim copies from the
official `excalidraw/excalidraw-libraries` GitHub repo, MIT-licensed under
that repo's own `LICENSE`; see `ATTRIBUTION.md` there for the per-file
author/source table. A scene compresses to ≤ `DIAGRAM.maxInlineBytes`
(120 KB) rides inline in the message (180-day retention, same as any
message); larger scenes go to the blob store instead (7-day media
retention — the tile says so). A pre-1.2 client has no `'diagram'`
`MsgBody.kind`, so it just renders `MsgBody.text`, which is why every
diagram message's text is the fallback line
(`diagramFallbackText` in `src/shared/diagram.ts`).

## Renderer navigation guard (1.2)

`src/main/navGuard.ts`'s `lockNavigation()` is attached to both the main
window and the splash window's `WebContents` and blocks `will-navigate` off
the app's own document — an `http(s)` target goes to the OS browser via
`shell.openExternal`, anything else is just dropped. Closes a real hole, not
a hypothetical one: Excalidraw's SVG export wraps a linked shape in a bare
`<a href>` with no `target`, and the diagram tile inserts that markup into
the page, so a peer's diagram could otherwise navigate this window — bridge
still attached — to a URL of their choosing on one click. Paired with
`src/renderer/src/diagram/sanitize.ts`, which strips `link` from every
element on the render path before it ever reaches the DOM.

## Share I/O tiers (1.2)

Cadence lives in three places: `POLL`/`BEACON`/`IO_BUDGET` in
`src/shared/constants.ts` (the numbers), `src/main/services/ioTier.ts`
(`IoTierManager` — derives `focused`/`blurred`/`idle`/`paused` from window
focus/visibility, `powerMonitor.getSystemIdleTime()`, and lock/suspend; pure,
so it takes fake timers in tests without a real Electron `app`), and
`src/main/transport/beacon.ts` (`BeaconWriter.setTier` — heartbeat cadence,
`presence.idleSec`, and a single goodbye beacon before going silent while
paused). `IO_BUDGET` (`focusedOpsPerMin: 96`, `blurredOpsPerMin: 48`,
`idleOpsPerMin: 16`) is asserted by a fake-timer, multi-peer test in
`src/main/transport/poller.test.ts` ("share I/O budget" describe block) —
read `docs/contract-changes-1.2.md` before touching any of these three
numbers, since two of them were already raised once (12→16, 42→48) after
this same harness proved the originals sat *below* the arithmetic floor of
the cadences the contract itself specifies.

**`git stash` is forbidden in this tree while agents work in parallel.**
Several people's uncommitted edits can be live in the working copy at once
during a multi-stream release like this one; a stash silently rewinds files
another agent is mid-edit on, and unstashing later does not put everyone
back where they were. Commit or leave changes in place instead. Say it
plainly: this cost real work during 1.2.

## Screen share picker (1.2)

One path, every platform, every macOS version: `listSources()`
(`src/main/services/capture.ts`) always enumerates through
`desktopCapturer`; `orderSources` (pure, unit-tested) puts screens first,
primary display first among them, windows after, and the picker pre-selects
the primary screen. The macOS 15+ native system picker
(`useSystemPicker`/`usesSystemPicker()`) is gone — it defaulted to windows
and gave no in-app cue, and combined with the older custom picker starting
with nothing selected, both produced the same bug report: "screen share only
shares the Chat window." **This was never an Apple entitlement/notarization
issue** — no special right is needed for screen capture; it was Chat's own
defaults. The permission check still runs only *after* an attempted capture,
never before (see the screen-recording section above) — now also covering
the case where permission reads granted but every screen thumbnail is
suspiciously uniform (`allScreensLookBlank` in
`src/renderer/src/screenshare/manager.ts`), which reads the same as no grant
at all and shows the same explainer.
