# Chat 1.2 — private groups, diagrams, channel management, less share traffic

Eight features from one release, documented at the level of `docs/features-1.1.md`.
Read `CLAUDE.md` first. Iron rules that matter most here: zero deps, `node:crypto`/
WebCrypto only, one writer per file (temp-write + rename), polling only, sign-then-
encrypt with AAD bound to `scope|relPath|objectId`, renderer is sandboxed web code
behind the typed bridge (`src/shared/bridge.ts` → `src/preload/index.ts` →
`src/main/ipc.ts` / `services/*Ipc.ts`).

This document describes what shipped, not the plan that proposed it — the plan
lives at `~/.claude/plans/chat-1-2.md` and `docs/contract-changes-1.2.md` records,
dated, every place the implementation deviated from its contract — across both a
contract-review round and the fix round that followed it. Where this doc and that
file disagree, the code — and `contract-changes-1.2.md` — win.

## 0. Compatibility during rollout

1.1.x and 1.2 clients read and write the same team folder for as long as a team
takes to update everyone. Nothing in 1.2 changes the envelope format, key
derivation, or any existing on-share file shape — every new thing is either a new
top-level directory (`groups/`), a new field on an existing record (`BeaconContent
.grpSealed` / `.app`, `ChannelMeta.fixed`), or a new `sys` event kind inside a log
`sysLine()` already exhaustively switches on (TypeScript fails the build if a kind
is added to `SysPayload` without a matching case, so this is enforced, not just a
convention). Per-feature sections below state precisely what a 1.1.x client does
with each addition — some are handled better than expected because the relevant
`sys.kind` string literal (`channel-renamed`) already existed, unused, in 1.1.2.

## 1. Channel rename / delete

### Design

Rides the existing per-channel event log as two `sys` kinds — `channel-renamed`
(`data: { name }`) and `channel-deleted` (`data: {}`) — folded last-writer-wins by
event id (`foldChannelSys` in `src/main/services/channels.ts`). `channel.json.e1`,
the one-time metadata file every client reads once and caches forever, is never
rewritten: a client that already cached the old name would never see a rewrite
anyway, which is exactly why this is an event, not a metadata edit.

A rename after a delete still folds (LWW doesn't know about deletion, only about
event ids), but it can never resurrect the channel: `channelViews()` omits any
channel with `deletedAt` set regardless of what its `name` field says, so the
renamed-then-deleted case is invisible by construction, not by a special case.

**The refusal holds on the reading side too, not just at the command.** Only
`deleteChannel` checks `fixedChannelId` before publishing — but `foldChannelSys`
also refuses to fold a `channel-deleted` tombstone when `state.meta.fixed` is set,
and `ChatService.foldSys` applies the equivalent refusal for the fold-computed
home channel of a team that predates the `fixed` flag. Enforcing it only where the
event gets published would leave the rule dependent on whoever happens to be
writing; a client with a stale idea of which channel is fixed, or one that simply
crafts the event by hand, would otherwise be able to empty the whole team's
sidebar with nowhere to land.

**The fixed channel.** Exactly one channel per team can't be renamed or deleted —
`ChannelMeta.fixed?: true`, written by the bootstrap `general` channel on a 1.2
team. For a team created before 1.2 (no channel carries the flag), `fixedChannelId`
in `channels.ts` falls back to the oldest channel by `meta.created`, ties broken by
the lowest `channelId` — deterministic so every client picks the same one without
coordination.

### On-share layout

No new directories. `channel-renamed`/`channel-deleted` are ordinary `.sys.e1`
files inside `channels/<channelId>/events/<day>/`, same as any other channel
event.

### Bridge

```ts
chat.renameChannel(conv: ConvId, name: string): Promise<void>
chat.deleteChannel(conv: ConvId): Promise<void>
```
Both reject the fixed channel and validate the name through `normalizeChannelName`
(`src/shared/channelName.ts`: lower-cased, whitespace collapsed to dashes, a
leading `#` stripped, `\p{C}` — control, format/bidi-override, and other
non-printing Unicode categories — stripped, capped at 40 chars). That function is
a 1.2 review fix in itself: the sidebar's create field and `channels.ts`'s fold
used to each carry their own copy (`/^#/` vs `/^#+/`, one capped at 40 and the
other not), so a name could pass the renderer's check and still come back
reshaped once it round-tripped through the fold. One function, imported by both,
closes that gap. A successful call publishes the sys event and pushes a fresh
`channels` list to every window.

### UI

`ChannelRow`'s hover/right-click menu gains **Rename…** and **Delete…**. On the
fixed channel both items render disabled with the tooltip/menu note "Home channel
— can't be renamed or deleted." Rename is an inline text input in the row itself.
Delete opens a confirm dialog: "Delete #name for everyone? Messages stay on the
share until the next cleanup (about 3 days), then they're gone." (the number comes
from `RETENTION.deletedConvGraceDays`, interpolated, not hard-coded prose). When
`countPreTombstonePeers` (`src/renderer/src/app/outdatedPeers.ts`) counts any
currently-present teammate whose beacon-advertised `app` version is older than
1.2.0 (or absent — a 1.2+ client that hasn't beaconed yet reads the same as
pre-1.2), the dialog adds a warning line: "*N* teammate(s) is/are on an older Chat
and will keep seeing this channel until they update." — because a 1.1.x client has
no fold for `channel-deleted` at all and just keeps posting into it.

If the conversation you're currently looking at vanishes — someone deleted it, or
(for a group) you left or were removed — `resolveActiveConvVanish`
(`src/renderer/src/store/convVanish.ts`) is a pure reducer that decides where to
land (the fixed channel, else the first channel, else nowhere) and what to toast,
e.g. "#standup was deleted by Ana." It's invoked from both the `channels` and
`groups` push handlers in the store.

### Tests

`src/main/services/channels.test.ts` (fold semantics, fixed-channel rule, rename-
after-delete, the reader-side refusal for a `fixed` channel and for a pre-1.2
team's fold-computed home channel), `janitor.test.ts` (a deleted conversation's
directory is removed only once *both* the folded `deletedAt` and the directory's
own mtime are past `RETENTION.deletedConvGraceDays` — the second clock exists
because `deletedAt` is an HLC stamp its writer chose, so a badly-skewed or
deliberately back-dated tombstone must not shortcut the grace period that lets an
offline client come back and still read it), `src/renderer/src/app/
outdatedPeers.test.ts` (`isOlderApp` version comparison, `countPreTombstonePeers`),
`src/renderer/src/store/convVanish.test.ts` (toast text and landing target for
every vanish cause).

### Compatibility with 1.1.x

`channel-renamed` is, unexpectedly, already fully supported by a shipped 1.1.2
binary: `channel-renamed` was already a literal in 1.1.2's `SysPayload.kind` union
and `sysLine()` already had a matching case ("Ana renamed this channel to
#standup") — it was simply never published by anything in 1.1. A 1.2 client's
rename event therefore renders correctly as a chat line in a 1.1.2 client's
timeline. What 1.1.2 does **not** have is `channels.ts`'s fold logic — there is no
`renameStem`/`deletedAt` bookkeeping in that binary — so the channel itself keeps
its original name in a 1.1 sidebar forever; only the chat-log line reflects the
rename. `channel-deleted` has no case in 1.1.2's `sysLine()` switch at all (it's a
new kind), so the compiled function falls off the end and returns `undefined` for
it; `SysRow` renders that as an empty centred row (harmless, but a hunt-for-the-
missing-line hazard) — and, as with rename, the channel keeps appearing in a 1.1
sidebar since that client folds none of this. A 1.1.x user can therefore keep
typing into a channel a 1.2 teammate has deleted, with no signal that anything
changed; those writes are invisible to every 1.2 client, since a 1.2 client
closes a deleted conversation for reading *and* writing alike, and they stop
existing once the directory itself is removed. A 1.1 janitor winner sweeps
neither a deleted conversation's directory nor `groups/` at all — its
`SWEEP_EVENT_ROOTS` is exactly `[DIR.channels, DIR.dm]` and it has no
deleted-conv step (`docs/contract-changes-1.2.md`) — so the removal always
happens on the next cycle a 1.2 client wins the janitor's daily claim, and both
sweeps are idempotent regardless of which version runs them.

## 2. Private groups

### Design

A new `grp:<groupId>` `ConvId` kind (`isGrpConv()` in `src/shared/ids.ts`). A
group is nothing but a random 32-byte key: the owner generates it, and everyone's
copy arrives as a `group-invite` notice **inside the owner↔member DM log** —
already end-to-end encrypted under the DM pair key, already polled every tick, and
carrying no membership information in any filename. There is no group discovery
mechanism and no group directory listing anywhere on the share; a device that
never received an invite cannot find, name, or prove the existence of a group it
isn't in.

**`group-invite`/`group-rekey`/`group-removed` ride their own event type, not
`sys`.** This was a mid-review fix (`docs/contract-changes-1.2.md`, 2026-09-11):
the first cut of this feature sent all three as ordinary `sys` events into the DM
log, and a shipped 1.1.2 client's `sysLine()` has no default branch in its switch
— an unrecognized `sys.kind` falls off the end, returns `undefined`, and draws a
blank centred row in the middle of that person's DM every time an invite or rekey
landed. So they moved to `EventType += 'grp'` (`GrpPayload` in
`src/shared/types.ts`, `.grp.e1` on disk) exactly the way `cal`/`prs` did in 1.1:
a `.grp.e1` filename doesn't match 1.1's event-filename regex (`EVENT_RE` in
`src/shared/ids.ts`) at all, so the file is skipped without a trace — no blank
row, nothing. The group's *own* log (`group-created`, `group-renamed`, etc., under
`groups/<token>/events/`) is unaffected and still uses ordinary `sys` events,
since a 1.1 client never looks at `groups/` in the first place. `merge.ts` folds a
`grp` event into the very same `sys`-row list under the same `kind` strings, so
`sysLine()` and the conversation-vanished handling work unchanged for a 1.2
reader; `sysLine()` also gained a `default` branch (a neutral line) so this class
of bug can't recur when a future release adds another kind
(`renderer/src/chat/sysLine.test.ts`).

The group's own event log lives at `groups/<token>/events/`, where
`token = base32(HMAC(key1, HKDF_INFO.grpDirToken))[0:20]` (`groupDirToken()` in
`src/main/crypto/keys.ts`, mirroring `dmPairToken`). Only someone holding the
epoch-1 key can compute `token`, which is why every invite or rekey that carries an
epoch above 1 also carries `key1` — without it, a newcomer could not even locate
the directory (`docs/contract-changes-1.2.md`'s 2026-09-10 `GroupInviteData.key1`
entry documents this as a plan/implementation wording mismatch — the plan's own
§2 text already required it, only a comment in `types.ts` undersold it — not a
behavior change).

**Membership fold.** The group's log is folded LWW like a channel
(`foldGroupLog` in `src/main/services/groups.ts`), with per-event-kind
authorization evaluated *at that point in the fold*: `group-created`,
`group-renamed`, `group-members-added`, `group-left` count when the author is a
member at that moment; `group-member-removed` and `group-deleted` count only when
the author is the owner. An unauthorized tombstone is simply ignored — a former
member can't delete a group for everyone by replaying an old removed-owner
identity, and a non-owner can't remove anyone.

**A newcomer only ever adopts an invite the owner signed, and only the owner's
invite ever replaces the local snapshot.** Nothing on the share proves who owns
a group, so the one claim `GroupService.acceptKeys` trusts is a device's claim
about itself: creating a *new* local group record requires `data.owner ===
author` — the inviter must be the very owner they name, or the invite is
dropped and the recipient's client never even learns the group exists. For a
group this device already knows, a fresh invite/rekey can still *advance* its
key material from anyone in the group (that's the whole point of a rekey), but
only a newer invite **signed by the existing owner** is allowed to replace
`base` (the name/members snapshot every fold starts from) — a member's own "Add
people" invite carries whatever membership *their* client happened to have
folded, and taking that as `base` would re-admit anyone the owner had already
removed (and could roll back a rename with it). A member's invite is key
material and nothing else.

**Roles.** `role: 'owner' | 'member'` in `GroupView`, derived as `owner ===
selfDeviceId`. The owner can rename, add members, remove members, and delete the
group; a member can rename and leave. Membership is owner-managed end to end
(1.2 review): a newcomer's client only adopts an invite signed by the group's
owner — nothing on the share proves who owns a group, so a device's claim about
itself is the only one worth anything — so a member's "Add people" would send an
invite the other side refuses. `addMembers` throws `not-owner` for a non-owner,
`foldGroupLog` ignores a `group-members-added` from anyone but the owner, and
the row's menu hides the item for members. `leave()` deliberately does **not**
rotate the key: a departing member keeps a working copy of the current epoch key
and can still decrypt anything published under it afterwards if they keep the
folder — only a *removal* by the owner rotates. If a departure needs to cut
someone off rather than just take them off the list, the owner removes them
instead of waiting for them to leave.

**Rekey on removal.** Removing a member always rotates the key: `removeMember`
mints `keys[epoch+1]`, and the `group-member-removed` event itself is published
**under the new key**, so the removed device — which never receives it — cannot
even read that it happened (see "what a removed device can still see" below). The
new key is then handed to every remaining member as a `group-rekey` DM. Adding a
member never rotates: `addMembers` just seals the *current* epoch's key to the
newcomer (plus `key1` if the current epoch is above 1).

**Telling the removed member (2026-09-11 review fix).** The removal event lives in
the group's log under the new key on purpose, so the device it names could never
read it there — left as-is, the group would just go quiet on that device forever,
which the original 1.2 contract listed as a known, accepted gap. `removeMember`
now also publishes a `group-removed` `grp` notice (`{ groupId, epoch, name }`, no
key material) into the owner↔removed-member DM. On receipt, once the author checks
out as *both* the group's owner *and* the peer on that exact DM (so nobody can
evict anyone from a group by writing into a DM of their own), the device drops the
group locally exactly the way `leave()` does, minus the publish. Best effort: if
that write fails, the device is left exactly where 1.1 would have left it.

**Partial failure is reported, never swallowed.** `create()` attempts every
invite even after one fails — a single unreachable teammate must not cost the
other four theirs — and if any did, it still returns the group (already pushed to
every window's sidebar) but throws `GroupPartialError` (carries the `GroupView`
plus the list of members who didn't get invited), so the caller can say "group
created; N invites failed — use Add people to retry" instead of going silent.
`removeMember` retries the post-rotation rekey the same way for every remaining
member and, on a partial failure there, throws a plain `Error` with matching
wording ("removed, but N rekeys failed — use Add people to retry") — same shape of
message, not the same exception class, since the group and the removal have
already happened by that point regardless.

**Parked events, never quarantined.** A record's `kid` names its epoch
(`KID.grp(token, epoch)`); a reader who doesn't yet hold that epoch's key (the
rekey DM may still be in flight) parks the filename in `pendingByEpoch[conv]`
instead of quarantining it, and replays every parked name the moment the epoch's
key lands (`GroupService.acceptKeys` → `events.replayParked`). This is what lets a
remaining member who ingests the removal event *before* the corresponding rekey DM
still end up reading it correctly once the DM arrives — order across the two logs
isn't guaranteed and doesn't need to be. Parking is bounded on both axes: at most
500 filenames held per conversation (`MAX_PARKED_PER_CONV` in
`src/main/transport/events.ts`), and a record claiming an epoch more than 8 above
the newest key this device holds (`MAX_EPOCH_LOOKAHEAD` in `groups.ts`) is
rejected outright rather than parked — a rotation's rekey DM is already on the
share before the first record under its new key is, so anything further out isn't
a rekey in flight, just a made-up `kid` that would otherwise let one writer fill
this device's parking lot.

**Unverified records never enter a `grp:` log at all.** A channel or DM shows an
unverified record with a warning chip rather than dropping it — the team key
already bounds who could have written it, and a lost roster entry shouldn't
silently swallow history. A private group can't afford that: every rule it has
(who may rename, remove, tombstone; whose retired-key write is refused) is a
statement about the *author*, and an unverified record has no author to hold to
any of it — anyone holding a leaked epoch key could otherwise write as the owner.
So `EventStore.ingestFile` refuses a `grp:` record outright the moment
`verifyRecord` fails, before anything below even runs.

**A removed member's post-rotation writes are ignored, not just unreadable.**
Rotating on removal stops the removed device from *reading* new group traffic, but
it keeps the retired key, and so does everyone else (for history). Without a rule,
the removed device could keep writing into the group under the old key and every
remaining member would still decrypt it. `GroupService.staleWriteCut()` (renamed
from the boolean `staleWrite()` in the 2026-09-11 review — see below) returns,
for a record that *did* verify, the point at which its epoch was retired, or
`null` if there's nothing to refuse: `null` when the record's epoch is current, or
when its author is still a member (a member writing late is fine). Otherwise the
caller — the decrypt path in `transport/events.ts` — compares that cutoff against
the file's own **mtime** (one `statMaybe`, only on this retired-epoch path), not
its filename stem: the stem is chosen by whoever writes the file, so a removed
device could simply back-date one and walk straight through a stem comparison.
The cutoff itself comes from `GroupState.rotations`, populated from whichever this
device can see first — the `group-member-removed` event itself, or the rekey/
invite that told it it's on the new epoch. History written *before* the rotation,
including the removed member's own old messages, still opens normally. This
behavior is documented in `docs/contract-changes-1.2.md` as an addition beyond the
original contract.

**What a removed device can still see.** Every message sent before the epoch that
removed it decrypts exactly as before — the old key never stops working on old
files. Nothing published after the rotation decrypts (wrong key), and nothing it
tries to write after that point is honored by anyone still in the group
(`staleWriteCut`). The device *does* learn it was removed — see "Telling the
removed member" above. That used to be a real gap (the original 1.2 contract, and
this document, called it out as deferred to a later release); the 2026-09-11
review round closed it, and it is no longer a deferred item in `CLAUDE.md`.

**Key material never reaches the renderer.** `redactEventForRenderer`
(`src/shared/prs.ts`) blanks `data.key`/`data.key1` on any `grp` payload before an
event crosses the bridge — on both the `chat:events` read path and a live `push`
— so a group's raw epoch key never sits in renderer memory; the renderer only
ever needs the group's name to draw a sys row.

**What a passphrase holder can see.** The team passphrase unlocks the *team* key
space, not any group's key — groups are DM-delivered and never touch team-scoped
key material. Someone holding only the team passphrase (no group invite) can list
`groups/` and see one opaque, unguessable directory name per group in existence,
and inside each, day-directories full of `.sys.e1`/`.msg.e1` files they can count
and size but not decrypt, sign, or attribute to anyone. That's the entire leak
surface: an existence count and a byte count, nothing about names, members, or
content.

**Beacon.** DMs and groups both get a *sealed* beacon section
(`BeaconContent.grpSealed`, generalizing the existing `dmSealed` machinery rather
than duplicating it): heads/cursor/typing for a `grp:` conv are encrypted under
that group's current epoch key with `kid = KID.grp(token, epoch)`, so anyone
without that key sees an opaque per-token blob and nothing else.
`BeaconWriter.noteOwnEvent` routes any sealed conv (`isDmConv || isGrpConv`) to
`sealedSections`, never the plain `heads` map. A reader tries every key it holds
for a group it recognizes the token of, since the writer may be an epoch ahead or
behind — and skips a `grpSealed` section entirely when the writer isn't in that
group's current folded membership (`GroupService.isMember`): a removed device
keeps every key it was ever handed and may go on sealing a section out of habit,
but holding a key was never the same as being a member.

**A second, separate ring for DM-borne group notices.** `group-invite`/
`group-rekey`/`group-removed` still travel inside the *DM's* beacon section, not
the group's own — and specifically not in that section's plain `heads` array.
`DmBeaconSection.grpHeads` (a 4-entry ring, mirroring `heads`) is where
`noteOwnEvent` puts a freshly-published `.grp.e1` filename instead, because the DM
peer may still be on 1.1: they *can* open that section (it's their own DM), and a
filename their client can't parse would otherwise read there as a missing head —
costing them a full `catchUp` of the DM on every beacon this device publishes.
Landing in a field they've never heard of costs them nothing. A 1.2 reader ingests
`grpHeads` in `Poller.processObservation` exactly like any other head list.

**Notifications.** Groups notify like DMs (always, unlike channels' @mention-only
default), with the title `"${who} in 🔒 ${groupName}"`.

### On-share layout

```
groups/<token>/events/<YYYY-MM-DD>/<hlc>-<ctr>-<dev8>.sys.e1   (and .msg.e1, etc.)
```
No metadata file — the invite carries the name and membership, and the log itself
is authoritative for everything else.

### Bridge

```ts
groups: {
  list(): Promise<GroupView[]>
  create(name: string, members: string[]): Promise<GroupView>
  rename(conv: ConvId, name: string): Promise<void>
  addMembers(conv: ConvId, members: string[]): Promise<void>   // owner only, no rotation
  removeMember(conv: ConvId, member: string): Promise<void>    // owner only, rotates
  leave(conv: ConvId): Promise<void>
  remove(conv: ConvId): Promise<void>                          // owner only, tombstones
}
```
Plus `PushMessage { kind: 'groups'; groups: GroupView[] }` — a full replace, like
`channels`; a group you left or that was deleted is simply absent from the next
push.

### UI

Sidebar section **Groups** between Channels and Direct messages (lock glyph, `+`
opens `GroupDialog` with a searchable member picker drawn from non-departed
presence, excluding self). Each `GroupRow` behaves like a DM row with unread
badges, and its menu is role-gated: **Rename…** for anyone, plus **Add people…**,
**Manage members…** and **Delete group…** for the owner, or **Leave…** for a
member.
`ChannelHeader` shows `🔒 <name> · N members` for an open group; `RightRail`'s
Members tab lists the group's own roster; its About tab reads "Only N people can
read it — invites travel as a direct message, so nobody else on the team can see
who's in it." A brand-new, empty group shows "Only N people can read this. Say
hi."

### Tests

`src/main/services/groupFold.test.ts` (fold LWW, authorization-at-that-point,
rotation bookkeeping, and — 1.2 review — "applies an add only from the owner"),
`src/main/transport/integration.test.ts` (3-client scenarios: create → invite
lands via DM → a third client can't compute the directory token and sees nothing;
rename LWW; add member; remove member rotates — the removed client can't read
post-rotation events, a remaining client that ingests the removal *before* the
rekey parks and replays it after; leave; delete → hidden everywhere → janitor
removes after grace; beacon `grpSealed` round-trip and non-member skip; an
unauthorized `group-deleted` from a non-owner is ignored; and, from the review
round, "lets only the owner add people, in the command and in the fold"),
`renderer/src/chat/sysLine.test.ts` (the new `default` branch, and the
`group-removed` line's wording — "You were removed from 🔒 <name>"),
`src/renderer/src/store/convVanish.test.ts` (landing target and toast text when a
`group-removed` notice arrives over a DM).

### Compatibility with 1.1.x

A 1.1.x client has no `grp:` `ConvId` variant, no `groups/` entry in its
`SWEEP_EVENT_ROOTS` (verified: 1.1.2's list is exactly `[DIR.channels, DIR.dm]`),
and no UI concept of a group — a private group is invisible to it in every way
that matters: no sidebar entry, no polling of `groups/`, and the janitor on a 1.1
client simply never looks at that directory (so it neither sweeps a live group's
log nor a deleted group's tombstoned directory). Even the one place a 1.1 client's
poller *does* reach into a group-adjacent log — the owner↔member DM — now leaves
no visible trace at all: `group-invite`, `group-rekey`, and `group-removed` all
ride the `grp` event type (`.grp.e1` on disk) rather than `sys`, precisely because
an earlier cut of this feature published them as `sys` events and a shipped
1.1.2 binary's `sysLine()` switch has no default branch — an unrecognized
`sys.kind` fell off the end and drew a blank, centred row in the middle of that
person's DM every time an invite or rekey landed (`docs/contract-changes-1.2.md`,
2026-09-11). A `.grp.e1` filename simply doesn't match 1.1's event-filename regex
at all, so the file is skipped in silence on every scan: no blank row, no error,
nothing. The group itself, and every notice about it, remains entirely invisible
to a 1.1.x client.

## 3. Diagrams

### Design

`@excalidraw/excalidraw@0.18.1` (MIT, React 19, pure JS — chosen over tldraw
specifically because tldraw's license requires a watermark). The editor is a
full-window lazy-loaded overlay (`src/renderer/src/diagram/DiagramEditor.tsx`,
`React.lazy` + Suspense so chat startup never pays for it); `DiagramRoot.tsx` is
what the app shell mounts at startup and, critically, is also what arms
`window.EXCALIDRAW_ASSET_PATH` early enough (see Fonts, below).

**Inline vs. blob.** A finished scene is exported to JSON (`serializeAsJSON`),
compressed with raw deflate + base64 (`src/renderer/src/diagram/codec.ts`,
`CompressionStream('deflate-raw')` — a platform API, so no dependency and no DOM
requirement, which is also why `codec.test.ts` runs directly under Node). Scenes
are mostly repeated JSON keys and compress 8–12x. If the compressed scene is at
most `DIAGRAM.maxInlineBytes` (120 KB) **and** the whole event still clears
`EVENT.maxFileBytes` (256 KB) once the thumb and envelope overhead are counted
(`diagramFitsInline` in `src/shared/diagram.ts`), it ships **inline** inside the
message: `MsgBody.diagram.data` is the compressed string, and the diagram then
lives exactly as long as a message does (180 days, the ordinary event retention —
no separate cleanup, no share I/O to view it ever again). Otherwise it's staged
via `files.stageBytes` and sent as a `.excalidraw` attachment instead, which
inherits the blob store's ordinary **7-day** media retention — the tile says so
explicitly rather than letting it quietly rot.

**Thumbnail.** `makeSceneThumb` renders a WebP data URI inside
`EVENT.maxThumbBytes` (24 KB), stepping down resolution/quality
(512px/0.7 → … → 160px/0.5) until it fits — painted the instant the message
arrives, before anything decodes the scene.

**Local SVG render.** The tile (`DiagramTile.tsx`) shows the thumb first, then
(once actually scrolled into view, via `IntersectionObserver`, and only once the
lazy renderer module has loaded) upgrades to a crisp SVG rendered **locally** from
the decompressed scene JSON — no network, no share I/O beyond the original fetch
for a blob-backed diagram. Rendering is cached per event id.

**Fonts, self-hosted.** Excalidraw resolves every font URL against
`window.EXCALIDRAW_ASSET_PATH` and, when that's unset, falls back to
`https://esm.sh/@excalidraw/excalidraw@<version>/dist/prod/` — a CDN the CSP
blocks and the target networks can't reach anyway. `scripts/sync-
excalidraw-assets.mjs` copies `node_modules/@excalidraw/excalidraw/dist/prod/
fonts` into `src/renderer/public/excalidraw-assets/fonts` (Vite's `publicDir`, so
it's addressable both over `http://localhost:<port>/…` in dev and `file://…` in a
packaged build) — gitignored, regenerated from the dependency. `assets.ts` sets
`window.EXCALIDRAW_ASSET_PATH` to an **absolute** URL resolved against
`location.href` (not `location.origin`, which for a packaged build is the literal
string `"file://"` and would resolve to the filesystem root). Excalidraw's
`createUrls` *always* appends the esm.sh fallback after whatever
`EXCALIDRAW_ASSET_PATH` yields regardless, so `assets.ts` also monkey-patches the
global `FontFace` constructor to strip any `esm.sh` URL out of the `src` list
before construction — otherwise every font face issues a second, CSP-blocked
network request per glyph on every editor open (~230 console errors, measured).

**One CJK family is deliberately not shipped.** Xiaolai, Excalidraw's CJK
fallback face, is 12 MB of the 13 MB font set — for glyphs this team never types.
`sync-excalidraw-assets.mjs`'s `SKIP_FAMILIES` excludes it from the copy into
`public/`, and `assets.ts`'s `FontFace` patch (the same one that strips the
`esm.sh` fallback) points any source for that family at `local()` instead of a
URL, so the browser asks for a system copy rather than 404ing against a file that
was never synced — the first time someone pastes CJK text, this is what keeps the
console clean instead of throwing a failed request per glyph. The two lists have
to be kept in step by hand (a comment in each points at the other). With Xiaolai
excluded, the built renderer bundle (`out/renderer/`, fonts included) measures
**≈ 14 MB** — about 480 KB of which is the kept Excalidraw fonts (measured
against the current `out/` build).

**CSP additions (1.2):** `worker-src 'self' blob:` and `font-src 'self' data:`
were added to `src/renderer/index.html`'s CSP meta tag; nothing else was loosened
(confirmed in the current file — `default-src 'self'`, `script-src 'self'`, no
`https:` anywhere in `connect-src`).

**Bundled libraries.** Five `.excalidrawlib` files (software architecture, lo-fi
wireframing, UML/ER shapes, flowchart symbols, sticky notes — ~501 KB, 79 items,
no embedded raster images) fetched verbatim from the official
`excalidraw/excalidraw-libraries` GitHub repository, which is MIT-licensed; no
vendor-logo packs were included since those marks aren't Chat's to redistribute.
Full author/source/license table in `src/renderer/src/diagram/libraries/
ATTRIBUTION.md`.

**Export/import.** Export ▾ offers PNG / SVG / `.excalidraw` via
`files.saveBytesAs` (a native save dialog); Import opens `files.pickFile`
(native, filtered) or accepts a drag-and-drop of a `.excalidraw` file, or a PNG/
SVG that was exported with Excalidraw's "embed scene" option (a private PNG
`tEXt` chunk or an SVG comment, both keyed by the same MIME-string marker —
`sniffDroppedDiagram` in `src/renderer/src/diagram/scene.ts` does one substring
search on the raw bytes rather than loading Excalidraw just to find out).

**Not built: live co-editing.** "Edit a copy → send" is the discussion loop for
1.2 — one person edits, sends a new message, someone else can edit *that* copy
and send again. Real-time shared canvas editing is a v2 item (see `CLAUDE.md`); it
would also fight the I/O-budget work in the same release.

**Security hardening (added during the review/fix rounds).** A diagram is a JSON
document written by whoever sent it, and rendering it — unlike an image — means
turning parts of that document into live markup. Several fixes landed once this
was reviewed as an attack surface rather than a rendering feature:

- **The window can no longer be navigated out from under itself.**
  Excalidraw's SVG export wraps any element carrying a `link` in a plain
  `<a href="…">` with no `target`, and the diagram tile inserts that markup into
  the page — a click would navigate this window itself, preload bridge still
  attached, to a URL of the sender's choosing. Two independent layers close it:
  `src/renderer/src/diagram/sanitize.ts`'s `sanitizeScene()` strips `link` from
  every element on the *render* path (the tile and anything exported from it —
  the editor itself keeps links, since there a click already goes through
  `setWindowOpenHandler` → `shell.openExternal` like any other message link), and
  `src/main/navGuard.ts`'s `lockNavigation()` — attached to both the main window
  and the splash window — refuses any `will-navigate` off the app's own document
  regardless, handing an `http(s)` target to the OS browser and dropping anything
  else. Either alone would have closed this; both exist because sanitizing the
  input and locking the surface are different failure modes.
- **Only `data:` images survive.** `files[id].dataURL` is written straight into
  the exported SVG's `<image href>`, and the tile renders on scroll-into-view
  rather than on a click — a scene with a non-`data:` URL there would make every
  recipient fetch an attacker-chosen URL just by scrolling past the message.
  `sanitizeSceneFiles` keeps only entries whose `dataURL` passes `isDataUrl`
  (`src/renderer/src/content/parse.ts`), reading the scheme the way a browser
  does (leading C0/space ignored, so a padded `" https://…"` doesn't sneak past).
  The same function gates a diagram's own thumbnail: `DiagramTile.tsx` only ever
  paints `d.thumb` through `safeThumbSrc`, so a non-`data:` string a peer put in
  the `thumb` field is simply not rendered.
- **A ceiling on element count and on decompressed size.** `sanitizeScene` throws
  past `MAX_SCENE_ELEMENTS` (5000) — "well above any hand-drawn diagram; a scene
  past this is a weapon, not a drawing" — and separately, `codec.ts`'s
  `decodeScene` inflates under a running total capped at `MAX_DECODED_BYTES`
  (8 MB), cancelling the stream the instant it's crossed rather than inflating
  fully and measuring after: 120 KB of `DiagramBody.data`, the most a message may
  legally carry inline, can reach a 257x compression ratio on repeated
  whitespace, so an unbounded inflate of a hand-crafted event is a compression
  bomb, not a decode.
- **Per-editor-slot drafts, and a close confirmation that's honest about whether
  they were saved.** "New diagram in #design" and "edit a copy of Ana's diagram
  in #design" used to share one draft key, so opening the second silently
  destroyed the first's unsent work; `drafts.ts` now keys on conversation *plus*
  the message being replied to (`'new'` when there isn't one). Closing with
  unsaved changes opens a `ConfirmDialog`; its copy depends on whether
  `writeDraft` actually succeeded (it fails past 1.5M characters, or a full/
  private-mode `localStorage`) — "kept as a draft" only when it really was, "this
  now loses the unsent work" otherwise, rather than promising a save that didn't
  happen.
- **`SvgCache` is bounded by bytes, not by a stale insertion order.** The first
  version held 40 rendered SVGs and evicted the oldest *inserted* one — not a byte
  bound (one rendered diagram can be a megabyte or more once its fonts are
  embedded as base64), and not really an LRU either, since the tile someone keeps
  scrolling back to was the one that kept getting evicted and re-rendered.
  `svgCache.ts` now evicts least-recently-*used*, bounded by total markup size
  with an entry count as a secondary guard, and never evicts the entry just
  requested even if it alone exceeds the bound.
- **Staged files are deleted the moment they're consumed, not just once a day.**
  `files.stageBytes` parks bytes under `<userData>/staging/` so a diagram too big
  to inline can ride the ordinary blob-upload path. It used to rely entirely on a
  once-per-launch sweep of anything older than a day — a machine left running for
  a week accumulated every large diagram it had ever sent, in the clear, under
  userData. `src/main/services/staging.ts`'s `discardStaged` now runs right after
  the uploader consumes the file; the day-old sweep (`sweepStaging`) stays as the
  backstop for the cases that never reach the uploader (a failed send, a crash
  mid-upload).
- **`sanitizeFileName` hardening** (`src/main/services/blobs.ts`, shared by the
  diagram export path and file drops alike): strips path separators, NTFS/shell
  special characters, and control bytes from a caller- or peer-supplied name, and
  refuses to resolve to `.`/`..` after stripping — closing the `join(dir, '..')`
  escape a crafted name could otherwise reach.

### On-share layout

Inline diagrams add no new files — they're `MsgBody.diagram.data` inside an
ordinary `.msg.e1`. A blob-backed diagram is an ordinary blob under `blobs/`,
`AttachDraft` with `path` pointing at a staged file under `<userData>/staging/`
until the uploader consumes and deletes it (`discardStaged`); a once-a-day sweep
(`sweepStaging`) removes anything left over past a day as a backstop.

### Bridge

```ts
files: {
  pickFile(opts): Promise<{ path; name; bytes } | null>   // native open dialog, base64, ≤ 32 MB
  saveBytesAs(name, bytes, mime?): Promise<string | null>  // native save dialog
  stageBytes(name, bytes): Promise<{ path: string }>       // userData/staging/, for AttachDraft.path
}
```
`MsgBody.kind` gained `'diagram'`; `SendDraft.diagram?: DiagramBody`.

### UI

Composer toolbar gains a **Diagram** button next to Code/GIF
(`src/renderer/src/diagram/DiagramButton.tsx`), plus "Import diagram…" in the same
menu (opens the editor pre-armed to import). Dropping a `.excalidraw`/`.svg`/
`.png` with embedded scene metadata onto the chat pane opens the editor pre-
loaded. The tile caption reads "Diagram · N shapes"; actions are Open (view-only,
still offers Export), Edit a copy (opens the editor, sends as a reply), and
Export ▾. A blob-backed diagram whose blob has aged out of the 7-day retention
shows the same "cleaned up" state as any other expired attachment, rather than a
diagram-specific error.

### Tests

`src/renderer/src/diagram/codec.test.ts` (round-trip, the size guard, and the
8 MB decompression ceiling), `src/main/services/chatServiceDiagram.test.ts`
(inline-vs-blob decision, fallback text construction), plus a renderer-free test
of the "which tile" decision (`diagramTileKind` in `src/shared/diagram.ts`).
Security hardening from the review round has its own coverage:
`src/renderer/src/diagram/sanitize.test.ts` (link stripping, `data:`-only files,
the element-count cap), `src/main/navGuard.test.ts` (`isSameDocument` against a packaged `file://`
document and a dev-server one: same-document reloads allowed, everything else —
another file, http(s), `javascript:`/`data:`/`about:`/`chrome:` — refused),
`svgCache.test.ts`
(byte/entry bounds, LRU eviction, never evicting the just-requested entry),
`drafts.test.ts` (per-slot keying, the size guard), `src/main/services/
filesIpc.test.ts` (`sanitizeFileName` traversal/special-character cases, and
"discardStaged — the uploader deleting what it consumed"), and
`src/renderer/src/diagram/assets.test.ts` (`stripCdnSources`, the Xiaolai
`local()` fallback). `scripts/check-no-natives.mjs` additionally scans a built
`out/renderer/` for any reference to `sass`/`@parcel` — the diagram editor's
`sass` build-time dependency (via `chokidar` → the optional, native
`@parcel/watcher`) must never actually reach the shipped bundle, since neither is
imported from `src/`. `scripts/e2e-drive.mjs` sends an inline diagram via the
bridge directly (no canvas driving needed) and asserts the receiving client's
event has `body.kind === 'diagram'` and a thumb.

### Compatibility with 1.1.x

`MsgBody.kind` in 1.1.x has no `'diagram'` value, so a 1.1 client's `RichContent`
falls through to its plain-text branch and renders `MsgBody.text` — which is
exactly why every diagram message's `text` is populated with a fallback line,
`"📐 Diagram: <title> — update Chat to view it"` (`diagramFallbackText` in
`src/shared/diagram.ts`; `diagramTitleOf` recovers the title from that same string
for round-tripping). A 1.1 client shows that one line and nothing else — no
thumbnail, no attachment awareness of the `.excalidraw` blob for a large scene.

## 4. Code languages

### Design

The composer's `draft.lang` was always `null` before 1.2 — every code block went
through `hljs.highlightAuto` and needed to clear a relevance threshold of 5 to get
colored at all, which many short snippets never did. `renderer/src/content/
languages.ts` is now the single source of truth: a 22-entry `CODE_LANGUAGES` table
(hljs grammar id + display label), plus the explicit "Plain text" sentinel
(`PLAIN_TEXT_ID = 'plaintext'`, which must never fall through to auto-detection)
and "Auto-detect" (`id: null`, the only case that still uses
`hljs.highlightAuto`). Default is **TypeScript**; the choice is sticky across
launches via `localStorage` (`sem-composer-code-lang`).

The 22 languages: TypeScript, JavaScript, Python, Java, C#, Go, Rust, C, C++,
Kotlin, Swift, PHP, Ruby, SQL, JSON, YAML, Bash, PowerShell, HTML/XML, CSS,
Markdown, Dockerfile — plus Plain text and Auto-detect.

**Explicit beats auto.** When a block carries an explicit `lang`, `CodeBlock`
always calls `hljs.highlight` with that grammar — no relevance gate. An unknown
*explicit* id falls back to auto-detect under the existing gate. `HLJS_LANG_IDS`
(everything in the table except the plain-text sentinel and `null`) is what a test
checks against hljs's actually-registered grammars, so the table and the bundle
can never drift apart silently.

### Bridge

No bridge changes — `draft.lang` already existed in `SendDraft`; 1.2 is the first
thing to actually set it to something other than `null`.

### UI

A language chip next to the Code button in the composer ("TypeScript ▾") opens the
table as a list; the paste-as-code chip reuses whatever the chip is currently set
to. Keyboard: reachable by Tab, closes on Esc. `CodeBlock`'s badge shows the full
label ("TypeScript"), not the raw hljs id.

### Tests

Language-table consistency (every non-null, non-plaintext id is actually
registered with hljs) and "`CodeBlock` picks explicit over auto" live next to
`content/CodeBlock.tsx` and `content/languages.ts`.

### Compatibility with 1.1.x

Fully forward-compatible: `lang` was already a field on `MsgBody`/`BodyEntity`
before 1.2, so a 1.1 client already renders a colored (or auto-detected) code
block for a message a 1.2 client sent with an explicit language — the only thing
that changed is which value that field usually carries.

## 5. Azure repo editing

### Design

Editing an already-configured PR connection used to make you re-paste your token
to see the repo list again. `PrsPrefs.tsx` now auto-probes on open: if
`status.configured` is true and the token field is still empty, it silently runs
the same `test()` path used by the manual "Test connection" button (spinner:
"Checking the saved connection…") — because `prService`'s `probeToken()` already
falls back to whatever token this device has for that origin (shared or
personal), so there was already a token available; the prefs pane simply wasn't
trying it before now. A saved repository the live Azure DevOps project no longer
returns doesn't just vanish from the list — it renders as its own greyed row
labeled "not found on server", uncheckable-to-remove, so removing a decommissioned
repo from the tracked set is a deliberate uncheck-and-save rather than a silent
list refresh doing it for you. If the auto-probe fails (typically: no token stored
on *this* device because it was never shared), the pane falls back to exactly the
inline error state it already had — nothing about the manual flow changed.

### Bridge

No bridge changes — this is pure `PrsPrefs.tsx` sequencing on top of the existing
`prs.testConnection` / `prs.listRepos` / `prs.saveConfig` calls from 1.1.

### UI

On mount, with `configured && token === ''`: an automatic probe with a "Checking
the saved connection…" spinner (distinct from the button's own spinner, so only
the silent on-open attempt shows this specific copy). Once it settles, repos load
and the previously-saved ones are pre-checked; the "not found on server" rows sit
alongside live ones, sorted together, greyed with an italic label and no live
default-branch data. Saving with the token field left blank still keeps the
device's existing stored token (already true in 1.1; unchanged).

### Tests

Existing `prService.test.ts` / `ado.test.ts` coverage is unchanged; the pane logic
itself (stale-row computation, probe-key invalidation on edit) is pure enough
inside `PrsPrefs.tsx`'s memos to be exercised by a component test if one is added,
but no new dedicated pane test file was required for this feature.

### Compatibility with 1.1.x

No wire format changed — `PrsConfig` and `PrsPayload` are exactly what 1.1.x
already publishes and reads. This is a renderer-only UX improvement; a 1.1.x
client's prefs pane behaves exactly as it did in 1.1.

## 6. Screen share picker & permission flow

### Design

Two separate pre-1.2 bugs produced the same symptom — "screen share only shares
the Chat window" — and 1.2 fixes both by deleting a branch rather than adding one.
On macOS ≤ 14 and on Windows, the custom picker used to start with nothing pre-
selected, and without the Screen Recording grant, macOS itself only ever handed
the app *its own* windows — so a "share my screen" attempt actually captured the
wallpaper plus the Chat window. On macOS 15+, the app instead used the native
system picker, which defaults to windows and gives no in-app cue about what got
picked. **This is not an Apple entitlement or notarization issue** — no special
right is needed for screen capture; it was a UX and defaults problem in Chat's own
code.

The fix is one path everywhere: `useSystemPicker`/`usesSystemPicker()` are gone
(`systemPicker` stays in the return type, hardcoded `false`, so the renderer
contract doesn't need to change). `listSources()` (`src/main/services/capture.ts`)
always enumerates through `desktopCapturer`, and `orderSources` (pure, unit-
tested) puts screens first — primary display first among them, matched by
`screen.getPrimaryDisplay().id` against `DesktopCapturerSource.display_id` (or, if
that field comes back empty and there's exactly one screen, that lone screen is
still the only sane primary) — with windows after. The picker pre-selects the
primary screen, so "Start sharing" works with one click for the overwhelmingly
common case.

**Permission check comes after the attempt, never before** (the existing CLAUDE.md
rule: macOS only lists an app under Privacy → Screen Recording once it has
actually tried to capture, so checking `getMediaAccessStatus('screen')` first and
bailing sends people to a Settings pane where Chat isn't even listed). After
`listSources()` has already run, if `screenPermission() !== 'granted'` — or the
permission reads granted but every screen thumbnail looks blank/uniform
(`allScreensLookBlank`, using compressed thumbnail byte size as a cheap "is this
actually just a flat color" proxy, since decoding real pixels would need a native
dependency Chat forbids) — the picker is replaced by the existing `PermissionPanel`
explainer/relaunch flow instead of a grid of misleading thumbnails.

**macOS 15+ reminder.** The OS may periodically show its own "Chat can record this
screen" notification while sharing — this is Apple's own nudge (unrelated to
anything Chat does) and the permission panel copy and README both say so, so it
doesn't read as an error.

**Presenter banner.** Names the actual source: "Sharing Display 1 · 02:13" or
"Sharing window: Xcode · 02:13", cross-checked against what WebRTC actually
captured (`getSettings().displaySurface`, via `resolveSourceKind`) rather than
just trusting the picked source's declared kind — platform quirks around
full-screen windows can disagree with what was requested. "Switch source" stops
and reopens the picker for the same conversation.

### Bridge

No bridge shape changes; `ScreenSourceView` gained an optional `primary?: true`
flag used only for picker pre-selection.

### UI

One picker, everywhere, screens-first with the primary pre-selected. The
permission panel gained one line: "After updating Chat, macOS may ask for this
again — that's normal for internally built apps."

### Tests

`orderSources` (source ordering, including the empty-`displayId`/single-screen
fallback) and the permission-panel decision (`shouldShowPermissionPanel`,
`allScreensLookBlank`, `looksBlankThumbnail`) are pure functions with unit tests
in `src/main/services/capture.test.ts`. WebRTC/native-permission-prompt behavior
itself can't be driven from a test harness — verified manually on this Mac with a
built app instead (screens listed first and pre-selected; a real Allow/Deny click
on the system prompt remains a manual step no CI can automate).

### Compatibility with 1.1.x

Screen sharing has no shared-folder footprint beyond RTC signaling and (in the
fallback path) the frame-relay files under `screens/`, neither of which changed
shape. A 1.1.x presenter still picks a source with its old (buggy) picker logic; a
1.2 viewer watching a 1.1.x presenter's share is unaffected either way — this
feature is entirely local to the presenter's own machine.

## 7. Peer-version banner

### Design

Before 1.2, a client only learned about a new release by polling
`apps/version.json` itself — so a team could be fully upgraded except for one
laptop that happened to be offline when the manifest was written, silently
falling behind with no signal. 1.2 adds an `app` field to `BeaconContent`
(`this.getAppVersion()`, injected into `BeaconWriter` the same way `updates.ts`
injects its own version seam so tests need no real Electron `app`). Every peer's
beacon — read on the ordinary polling cadence, zero extra share I/O — now
advertises its own Chat version, surfaced to the renderer as `PresenceView.app`.

When `UpdateService.notePeerVersion(version, peerName)` sees a semver-greater
version than this build's own, and hasn't already announced that exact version
once, it forces an immediate `apps/version.json` re-check
(`check({ force: true, covering: version })`). Two outcomes:

- The manifest already covers that version (the usual case — someone just
  finished a normal release) → the ordinary `source: 'manifest'` banner, as if the
  peer had said nothing.
- It doesn't yet (someone updated by hand, or the manifest write raced this
  client's read) → a `source: 'peer'` banner, and the client keeps re-checking the
  manifest every 60 s for 10 minutes in case the zip is still being copied —
  flipping over to the normal banner the moment it lands.

**The peer variant reads as a claim, not a fact — and says so (2026-09-11 review
fix).** It's raised by a teammate's beacon, not by anything signed with the
release key, so it doesn't borrow the manifest banner's wording ("… is
available"). `peerSentence()` (`src/renderer/src/app/updateBannerState.ts`)
renders it as "*<name>* says they're on Chat *<version>* — no signed build in the
apps folder yet.", with `blocking: false` and `zipAvailable: false`; the name is
untrusted text off the share sitting in a sentence, so `shortPeerName` clamps it
to 40 characters (`MAX_PEER_NAME`) before it's interpolated.

**"Remind me later" is keyed per source now, not just per version** — same
review round. It used to be `update-later:<version>` alone, so dismissing the
peer rumor also silenced the real, signed manifest banner for that same version,
permanently (the key outlives the session). `laterKey(version, source)` now
produces `update-later:<source>:<version>`, and a manifest arriving additionally
clears any standing *peer* dismissal for its version (`forgetPeerDismissal`) — the
rumor's "later" should not survive the fact showing up to confirm it.

**Only 1.2+ clients can show this banner at all** — the `app` field, the
peer-version listener, and the `source: 'peer'` banner variant are all new code;
a 1.1.x client has none of it and simply never raises a peer-sourced banner,
though it still raises the ordinary manifest-sourced one once a real release
lands. A 1.2 client's beacon carrying `app` is itself invisible on the share to
anyone not looking for it — no new file, one new key in an existing signed
record. The listener is also gated on the beacon's own signature
(`obs.verified`), the same gate `presenceViews()` uses for `PresenceView.app`: an
unsigned beacon can't put a version number, real or fabricated, in front of
anyone.

### On-share layout

No change — `app` rides inside the existing beacon record.

### Bridge

```ts
app.openAppsFolder(): Promise<void>   // shell.openPath(<team root>/apps)
```
`UpdateView` gained `source: 'manifest' | 'peer'`, `peerName?`, `zipAvailable`.

### UI

`UpdateBanner.tsx`'s peer variant: "*<name>* says they're on Chat *<version>* —
no signed build in the apps folder yet." with an "Open apps folder" action (calls
`app.openAppsFolder`) and "Remind me later" (dismissal keyed by source *and*
version — see above). It automatically becomes the normal "Copy to my machine"
banner once the signed manifest actually lands.

### Tests

`src/main/services/updates.test.ts` covers `notePeerVersion`'s branches (manifest
already covers it vs. not; one-announcement-per-version; the 10-minute recheck
window ending). `src/renderer/src/app/updateBannerState.test.ts` (node
environment, no DOM needed) pins the wording, the 40-char name clamp, the
per-source dismissal keys, and `forgetPeerDismissal`.

### Compatibility with 1.1.x

Verified directly against 1.1.2's own beacon reader logic: `BeaconReader.readOne`
does no schema validation on the decrypted JSON beyond what it actively reads —
adding `app` as an unrecognized extra key is silently ignored by both 1.1.x and
1.2 readers, so a mixed-version team never sees a parse failure from this field. A
1.1.x client, however, has no code path that reads or reacts to `app` at all, so
it never raises a peer-version banner — it only ever raises its own, existing
manifest-based one.

## 8. Share I/O tiers

### Design

The whole feature is "measure it, then cut it": `ShareIo`
(`src/main/transport/shareIo.ts`) counts every logical share primitive
(`readdir`/`read`/`stat`/`publish`/`delete`/`mkdir` — a publish's mkdir+write+
rename is one logical op, plus one extra `stat` when it also calibrates the share
clock) into a 60-bucket, one-second ring plus a running total, exposed as
`ShareIoStats` / the `diag:shareStats` bridge call / `ShareStats`.

**Tiers** (`IoTier = 'focused' | 'blurred' | 'idle' | 'paused'`, derived — never
set directly — in `IoTierManager`, `src/main/services/ioTier.ts`, from window
focus/visibility, `powerMonitor.getSystemIdleTime()` sampled every 30 s
(`IDLE_SAMPLE_MS`), and `lock-screen`/`unlock-screen`/`suspend`/`resume`):

| tier | beacon tick | beacon heartbeat | blanket sweep | drops inbox |
|---|---|---|---|---|
| focused | 1 s (`POLL.focusedMs`) | 20–23 s (`BEACON.heartbeatMs` + 0–3 s jitter) | 60 s (`POLL.sweepFocusedMs`) | 30 s (`POLL.dropsInboxMs`) |
| blurred | 3 s (`POLL.backgroundMs`) | 20–23 s | 3 min (`POLL.sweepBlurredMs`) | 30 s |
| idle (3 min without input, `POLL.idleAfterMs`) | 15 s (`POLL.idleMs`) | 45–48 s (`BEACON.idleHeartbeatMs` + jitter) | 10 min (`POLL.sweepIdleMs`) | 5 min (`POLL.dropsInboxIdleMs`) |
| paused (lock/suspend) | — no ticks at all | one final beacon (`presence.state: 'away'`), then silence | — | — |

**The idle row only ever applies to a window that is also unfocused (2026-09-11
review fix).** Taken at face value, the plan's "system idle ≥ `idleAfterMs`, *or*
window hidden and blurred for that long" put the idle tier onto a *focused*
window too — someone reading a long thread, or watching a screen share, with no
keystroke for three minutes dropped to 15 s ticks: typing indicators stopped
rendering and messages arrived in batches. `IoTierManager.derive()` now floors a
focused window at `blurred` regardless of idle time, and `idle` requires
`!focused` outright — a focused-but-idle window reads `blurred` (3 s), never
`idle` (15 s). Three quiet minutes still buy the cheaper cadence, they just never
buy the invisible one. `presence.idleSec` is unaffected and still travels
truthfully in every tier (see below), so a peer still flips this person to "away"
on schedule.

The idle heartbeat (45–48 s) is still under `PRESENCE.offlineAfterMs` (120 s), so
a 1.1.x reader watching an idle 1.2 peer sees "away," never a hole in presence.
The one beacon a `paused` device sends before going silent floors `idleSec` at
`PRESENCE.awayIdleSec` (300) regardless of how long the machine was actually idle
before it locked or slept (`Math.max(idleSec, PRESENCE.awayIdleSec)` in
`BeaconWriter.setTier`) — every reader, 1.1 and 1.2 alike, derives away/online
from `idleSec` rather than from `presence.state`, so without the floor a
lock-right-after-typing goodbye could still read as "online" until it aged past
`PRESENCE.offlineAfterMs`. The rtc/ signaling listener idles itself out
`POLL.rtcIdleOutMs` (2 minutes) after the last signal or session end; the
share-clock calibration stat rides at most one beacon publish every 5 minutes
(`CALIBRATE_EVERY_MS`, a private constant inside `beacon.ts` — not in
`shared/constants.ts`, since nothing outside that file needs it). Waking up
(unlock, resume, refocus, or real input) is immediate: one tick and a beacon
bump right away, then back onto the right tier's cadence.

There was also a heartbeat-jitter bug fixed as part of this work:
`Math.floor(Math.random() * 2 - 1)` only ever produced −1 or 0, so every client's
heartbeat systematically ran up to 15% early rather than the intended 0–3 s spread
— fixed to `Math.floor(Math.random() * BEACON.heartbeatJitterMs)`.

**Three correctness fixes travel with the cadence work, none of them a contract
change.** `Poller`'s tick loop carries a `chain` id: a tier speed-up (focus
regained, waking from lock) starts a fresh chain, and a tick still in flight from
the *previous*, slower one checks `id !== this.chain` before rescheduling and
bows out instead — without it, a speed-up mid-tick could leave two overlapping
loops running. Channel discovery lives inside the blanket sweep, so
`Poller.start()` now forces one on the very first tick (`lastSweepAt = 0`) rather
than waiting a full sweep period — a channel created while this device was away,
or one nobody had beaconed a head for yet, used to stay invisible for up to ten
minutes after launch. And a client that launches with the window already
unfocused used to poll at the flat `POLL.defaultMs` (1.5 s) forever, because
`setTier('blurred')` early-returns when the tier hasn't actually changed from its
default; `intervalMs` is now seeded from `tickMsFor(tier)` at construction, so an
unfocused launch starts on the blurred cadence immediately instead of quietly
running at the focused rate for the life of the process.

**Presence freshness rides the share clock, not the reader's own.**
`Poller.presenceViews()` used to derive online/away/offline from
`Date.now() - observedAtMono` — how long *this device* had known about a beacon —
which made the verdict depend on this reader's own tick rate (an idle reader
might not notice a fresh beacon for a full `POLL.idleMs`, and the 45–48 s idle
heartbeat plus jitter already leaves only 2 s of slack inside
`PRESENCE.onlineWithinMs`) and let an hours-old beacon read as "online" for up to
a minute after a cold start or a resume from a locked screen. It now uses the
stamp the beacon itself carries — `shareNow - min(content.hlc, shareNow)`, the
same value already surfaced as `lastSeenMs` — same thresholds, same states, only
the clock changed. `PresenceView.app` is gated on the beacon's signature the same
way the peer-version banner's listener is (§7): an unsigned beacon can't put a
version number, real or fabricated, on anyone's row.

**Budget.** `IO_BUDGET` (`shared/constants.ts`) — `focusedOpsPerMin: 96`,
`blurredOpsPerMin: 48`, `idleOpsPerMin: 16` — is asserted by a fake-timer,
multi-peer test in `src/main/transport/poller.test.ts` ("share I/O budget"
describe block), which runs a real poller, beacon writer, drops inbox, and rtc
listener against a counting fake share for **ten** simulated minutes per tier
(long enough that even the idle tier's ten-minute blanket sweep lands inside the
window) with four teammates heartbeating, and fails with the measured number
printed in the assertion message if any tier goes over. The idle and blurred
budgets were raised once this harness existed and could actually measure a
client — the original 12/42 values sat *below* the arithmetic floor of the very
cadences the same contract specifies (four peers' idle heartbeats alone are 5.33
ops/min, plus this device's own beacon at 2.67, is 8 ops/min before a single
sweep or inbox scan); see `docs/contract-changes-1.2.md` for the full
derivation, re-run after this section's review fixes. Measured, steady state,
team of five (so four peers), nobody chatting, one channel + four DMs + two team
logs, **before → after** these reductions: focused 148 → 87.6–88.0 ops/min,
blurred 78 → 42.0–42.4, idle 72 → 13.0–13.2, paused 78 → 0 (the own-beacon count
is a small range because `BEACON.heartbeatJitterMs` moves how many heartbeats
land inside a ten-minute window).

Headroom is thin by design, not generous: at the modelled team of five the
measurement sits roughly 8% (focused), 12% (blurred), and 18% (idle) under
budget — and the same harness at six peers (a team of seven) measures `blurred`
*over* `blurredOpsPerMin`, with the other two tiers inside by a whisker. Raising
the modelled team size means re-deriving the budgets, not just re-running the
assertion. Both the harness and the Settings → About readout count only
*metadata* traffic — the beacon loop, event publishes, blanket sweeps, the drops
inbox — because that's what the tiers actually control: blob and beam bodies are
excluded on purpose (`BlobService`/`DropService` stream through `node:fs`
directly against `ShareIo.abs()`, so a 100 MB transfer is one counted `stat` and
then nothing, which is why the Settings line reads "excluding file transfers").
`UpdateService`'s manifest poll and the once-a-day janitor run do go through
`ShareIo`, so they *do* appear in the Settings total, but not in the per-tier
budget, since neither is a per-tier cadence; Azure DevOps PR polling is
`net.fetch`, not share I/O, so it's in neither.

**Settings → About** shows the live rate: "*<rate>* ops/s now · *<total>* since
launch · *<tier label>*", polled every 2 s while the pane is open
(`ShareTraffic` in `src/renderer/src/app/SettingsModal.tsx`, backed by
`diag.shareStats()`), with a small "excluding file transfers" caption underneath.

### On-share layout

No change — this feature is entirely about *when* existing operations run, not
what they write.

### Bridge

```ts
diag: { shareStats(): Promise<ShareStats> }   // { sinceMs, total, byOp, lastMinute, ratePerSec, tier }
```

### UI

Settings → About/Advanced: a "Share traffic" label with a small "excluding file
transfers" caption underneath it, and the live value next to it —
"0.4 ops/s now · 1,234 since launch · idle" (the tier label is one of "active" /
"in the background" / "idle" / "paused (screen locked or asleep)").

### Tests

`src/main/transport/poller.test.ts` (the budget assertions above; presence-
during-first-poll edge cases; the "presence from a beacon" block covering the
share-clock-stamp derivation), `src/main/transport/shareIo.test.ts` (counter
correctness), `src/main/services/ioTier.test.ts` (tier derivation from focus/
visibility/idle/lock/suspend inputs, including "slows a focused window that
nobody is typing into, but never hides it" and "only the unfocused reach the idle
tier" from the review round).

### Compatibility with 1.1.x

Entirely a sender-side traffic-shaping change — a 1.1.x client's own polling
cadence is whatever 1.1.x always used (a flat cadence around every 1.5 s per the
1.1-era README, since 1.1.x predates tiers entirely) and is untouched by a 1.2
peer slowing down. Nothing about file formats, retention, or protocol semantics
changed; a slower-polling 1.2 peer is simply a quieter neighbor on the same share.
