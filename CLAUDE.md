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

Private channels · in-app passphrase rotation (new epoch + LMK re-wrap; until
then a departing member means a new team folder) · message-content search ·
screen-share audio · blob dedup ·
DM forward-secrecy prekeys · day-bundle compaction for multi-month cold starts
· beam transfers over RTCDataChannel (currently folder-only) · online GIF
search (needs a Giphy/Tenor key; the bundled pack is the offline path).

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
