# Semaphore

Encrypted team chat whose entire backend is a shared folder. No servers, no
internet required — built for teams on locked-down corporate networks where
the only thing every machine can reach is an SMB share.

![icon](resources/icon.png)

## What it does

- **Team channels + direct messages** — DMs are end-to-end encrypted
  (X25519); even teammates holding the team passphrase can't read them.
- **Presence, typing, read receipts** — via per-device beacon files; one
  directory listing per 1.5 s tells every client everything that changed.
- **Anti-impersonation** — every message is Ed25519-signed. The gray chip
  next to each name (`MBP-ANA·Q7RC`) is the hostname plus a fingerprint of
  the key that actually signed the message. A new device claiming a known
  name gets flagged loudly.
- **File sharing** — drag a file into the chat to share it with everyone
  (inline image/video/GIF previews, streaming video scrub straight off the
  share). Drag a file onto a *person* to beam it directly to them,
  AirDrop-style, with accept/decline.
- **Link previews** (Apple-Messages style), **code blocks** with syntax
  highlighting + copy button, **reactions, pins, edits, mentions**.
- **Screen sharing** — WebRTC peer-to-peer over the LAN when the network
  allows, automatic fallback to ~1 fps encrypted frame relay through the
  folder when it doesn't. The UI always tells you which mode you're in.
- **Self-cleaning** — clients cooperatively delete old media from the share
  (default: files after 7 days, messages after 180). No server needed.
- **Native notifications**, dark/light themes, offline outbox.

Everything written to the share is AES-256-GCM encrypted and bound to its
location (a moved, renamed, or replayed file fails authentication). The team
passphrase (scrypt, 128 MiB) is the only secret to distribute — in person.

## Developing (on the build Mac)

```bash
npm install
node --experimental-require-module node_modules/electron/install.js  # once
npm run dev            # one instance
npm run dev:a          # or two instances side by side…
npm run dev:b          # …against the same local folder
npm test               # unit + protocol integration tests
node scripts/e2e-drive.mjs   # live two-instance E2E (build first)
```

Node ≥ 22.12 recommended (on 22.11 the repo's scripts set
`--experimental-require-module` where needed).

## Building & releasing

```bash
npm run dist                              # mac + windows zips into dist/
SHARE_PATH=/Volumes/TeamShare npm run release   # + publish to the share
```

Both platforms build on the Mac — no Windows machine, no wine (electron-
builder ≥ 26 patches the exe with pure-JS resedit). The release script
generates an Ed25519 release key on first run (`~/.semaphore-release-key.json`)
and prints the public key — paste it into
`src/main/services/updates.ts` (`RELEASE_PUBKEY_B64URL`) and rebuild once so
clients only trust update manifests you signed.

Users install by copying a zip from `<share>/Semaphore/apps/`, extracting,
and double-clicking. No installers, no scripts. `README-INSTALL.txt` is
published alongside with the Gatekeeper/SmartScreen notes.

## Before first deployment (de-risk checklist)

1. `node scripts/share-conformance.mjs <path-on-real-share>` from one Mac
   **and** one Windows box (with clocks deliberately skewed ±10 min once) —
   verifies rename atomicity, exclusive create, and most importantly whether
   file mtimes come from the server clock (the janitor and clock calibration
   assume so).
2. Copy the win zip to the most locked-down Windows machine available and
   double-click. If AppLocker/WDAC blocks unsigned exes, ask IT for a path
   rule (e.g. `%LOCALAPPDATA%\Semaphore\*`) — no packaging trick beats
   allowlisting policy.
3. macOS screen sharing needs the Screen Recording permission (System
   Settings → Privacy & Security); expect a re-grant after app updates —
   normal for ad-hoc-signed internal builds.

## Layout

```
src/shared/     protocol types, envelope constants, canonical JSON, HLC, merge logic
src/main/       Electron main: crypto, transport (share I/O, beacons, events),
                services (blobs, beams, signaling, frames, janitor, updates), IPC
src/preload/    the single typed bridge surface
src/renderer/   React app: shell, onboarding, chat, rich content, screen share
scripts/        release, icons, no-natives gate, share conformance, live E2E
```
