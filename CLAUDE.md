# Semaphore — agent notes

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
- `safeStorage` reports unavailable here → the passphrase-LMK fallback path is
  what actually runs locally (unlock screen on each launch).

## Known deferred items (v2 candidates)

Private channels · message-content search · screen-share audio · blob dedup ·
DM forward-secrecy prekeys · day-bundle compaction for multi-month cold starts
· beam transfers over RTCDataChannel (currently folder-only) · bundled GIF
pack content (`resources/gifs-starter/manifest.json` format: array of
`{id, category, url, w, h}` — picker + `gifs:packList` already consume it).
