# Chat 1.3 — polls, live boards, whole-window editor

Three features from one release, documented at the level of `docs/features-1.2.md`.
Read `CLAUDE.md` first. Iron rules that matter most here: zero deps, `node:crypto`/
WebCrypto only, one writer per file on the share ever (temp-write + rename), polling
only, sign-then-encrypt with AAD bound to `scope|relPath|objectId`, renderer is
sandboxed web code behind the typed bridge (`src/shared/bridge.ts` →
`src/preload/index.ts` → `src/main/ipc.ts` / `services/*Ipc.ts`).

This document describes what shipped, not the plan that proposed it — the plan
lives at `~/.claude/plans/chat-1-3.md` and `docs/contract-changes-1.3.md` records,
dated, every place the implementation deviated from its contract, across the two
main-side/renderer-side/poll streams (A, B, C) and the fix batches that followed
review (FP, FR, FM). Where this doc and that file disagree, the code — and
`contract-changes-1.3.md` — win. A handful of numbers the plan estimated up front
(a session id's shape, the frame budget's accounting, the measured per-participant
cost) were corrected during the review round; this document states the corrected
versions and says so.

## 0. Compatibility during rollout

1.1.x, 1.2 and 1.3 clients read and write the same team folder for as long as a
team takes to update everyone. Nothing in 1.3 changes the envelope format, key
derivation, or any existing on-share file shape: a poll's vote is a new event
*type* (`vot`, `.vot.e1`) that an older client's filename regex simply does not
match, a live board is an entirely new top-level directory (`boards/`) that older
pollers and janitors never look inside, and the one new field on an existing
record (`BeaconContent.heads2` / `DmBeaconSection.heads2`) is exactly the same
trick 1.2 already shipped once for `grpHeads` — an unknown field an older reader
never reads costs it nothing. Per-feature sections below state precisely what a
1.1.x or 1.2 client does with each addition.

## 1. Polls & quick decisions

### Design

A poll is an ordinary message: `MsgBody.kind: 'poll'` carries a `PollBody`
(`question`, 2–10 `options` with unique ids, `multi`, `anonymous`, an optional
`closesAt`/`closedAt`, and `decision?: true` for the Yes/No/Abstain preset). A
vote is its own event type, `vot` (`.vot.e1` on disk) — `VotPayload { conv,
target, choice }`, where `target` is the poll message's own event stem and
`choice` is the array of option ids the voter picked (`[]` retracts). It does not
ride `sys`, does not touch read cursors, and never notifies: it only ever moves
the numbers on one message's tile.

**Materialization (`src/shared/merge.ts`).** Votes are folded per *target* and
then per *device* — a roster record is a device, and nothing on the share binds
two devices to one human, so the team treats device as person exactly the way
reactions and read receipts already do. Within one device's history, the vote
that counts is whichever has the highest event id among the ones that landed in
time — plain id-order last-writer-wins, the same rule a reaction uses, because
the stem is the only ordering every reader can agree on regardless of when the
file was actually observed. An empty choice removes the device's entry entirely
rather than leaving a `[]` on the record, so "did anyone vote" and "what did they
pick" stay the same question.

**Closing is the author's own `edt`.** There is no separate "close" event type:
`ChatService.closePoll` republishes the message's body through the ordinary edit
path with `poll.closedAt` set to the share-calibrated now, so a reader who was
offline for the whole poll still receives the closed state through the same
mechanism as any other edit. This is why `merge.ts`'s edit accumulator had to
start keying by **target and author together** rather than one slot per target:
before this release, anyone on the share could publish a later `edt` of a
message that was not theirs, have the apply step correctly refuse it as
unauthorized, and in doing so silently drop the *real* author's actual latest
edit along with it. For a poll that meant a single stray event from any team
member could re-open a poll that had already been closed and announced.

**A closed poll's result is final.** A poll closes two ways — the author's
`closedAt`, or the deadline it was published with (`closesAt`), whichever comes
first — and `merge.ts` ignores any vote (a fresh pick *or* a retraction) whose
event id carries an HLC timestamp later than that close plus a **5 second
grace window** (`VOTE_GRACE_MS`). The grace covers a vote that was already in
flight — published, but not yet ingested — when the author pressed Close; a
publish plus a beacon hop is well under a second, so 5 s is generous and nowhere
near "a vote cast an hour later." `chat.vote` also refuses synchronously against
both `closedAt` and `closesAt` at the moment of the call, so the only way a late
vote reaches the log at all is one that was already in flight — exactly the case
the grace window exists for. Before this rule, any reader who happened to ingest
a stray late vote showed a different tally, and potentially a different
decision, from a reader who had not.

**`closesAt` is restated on the share clock.** The renderer only knows the
author's own wall clock ("closes in 4 hours"); every reader — including the
sender — decides "is this closed?" by comparing `closesAt` against the *share*
clock, so publishing the author's raw `Date.now() + span` would make a
fast-clocked author's poll close early for everyone and a slow-clocked one
publish already-closed. `ChatService.send` therefore keeps only the *interval*
the renderer asked for and republishes it as `calibrateClosesAt(closesAt,
Date.now(), calibratedNow())`, clamped to 1 minute – 30 days. The renderer side
of the same problem is `HealthView.offsetMs` (additive, rides the existing
`health` push): main fills it in from `io.getClockOffsetMs()` once it has
calibrated against the share, the store keeps the last value it was told rather
than dropping it on a health push that arrives with none (an unreachable-share
push carries no fresh offset), and `PollTile` ticks and tallies against
`Date.now() + offsetMs` — which is exactly the old behavior when the offset is
still unknown (0). Without this, a machine an hour fast closed every timed poll
an hour early for that person alone, while main went on happily accepting votes
everyone else was still casting.

**Anonymous is UI-only.** `PollBody.anonymous` only hides voter names in
`PollTile`'s rows; the vote is still an ordinary signed `vot` event, fully
readable by anyone holding the conversation's key, exactly as the dialog's own
copy says ("Hides who voted for what in the app… this is politeness, not
secrecy").

**The decision rule.** `decisionIds` reads a poll's `yes`/`no` option ids (or,
for a hand-built poll that lacks them, the first two options in order);
`decisionOutcome` counts a strict majority of Yes against No votes and
deliberately leaves Abstain out of the arithmetic entirely — abstaining means
"don't count me," so four Yes against one No and six Abstain is still a Yes.
The closed tile reads `Decided: Yes (4–1)`, `Decided: No (3–1)`, or `No
decision` on a tie (including 0–0).

**Limits** (`POLL_LIMITS` in `shared/constants.ts`): 2–10 options, a 300-
character question, a 100-character option. `validatePollDraft` additionally
refuses two options that normalize to the same text (whitespace-collapsed,
trimmed, case-insensitive) — a 2026-09-12 review-round addition, because two
rows reading "Friday" and "friday " get distinct ids and silently split one
answer's votes across two rows, and a poll that was meant to settle something
instead reports a false 3–3. The renderer validates so the dialog can say what's
wrong; `ChatService.send` validates again through the same `validatePollDraft`,
because renderer input is untrusted regardless of what the dialog already
checked.

**Where the poll logic actually lives.** The plan filed all of the pure poll
logic under `src/renderer/src/poll/polls.ts`, but part of it cannot live there:
main needs the same answers the renderer does (the fallback text, the limits,
`isPollClosed`, `checkChoice`, `calibrateClosesAt`), and main must not import out
of `src/renderer`. It was split, exactly the way 1.2 split `shared/diagram.ts`
from `renderer/diagram/*`: `src/shared/poll.ts` holds what both processes must
agree on (tested in `src/shared/poll.test.ts`), and
`src/renderer/src/poll/polls.ts` keeps only the tile's own arithmetic — tally,
decision outcome, click-to-choice, countdown (tested in `polls.test.ts`). No
wire-shape changed by this split.

**`heads2` — and its corrected rationale.** New event types (`vot`, and
whatever comes after it) advertise their recent filenames in a new beacon field,
`heads2` (a plain `Record<ConvId, string[]>` alongside `heads`, and
`DmBeaconSection.heads2` inside the sealed DM/group sections), rather than in
`heads` itself. `HEADS_1_2_TYPES` in `beacon.ts` is an explicit allow-list of the
event types a 1.2 filename regex can parse (`msg`, `edt`, `del`, `rct`, `pin`,
`sys`, `prv`, `cal`, `prs`, `grp`); anything not on that list lands in `heads2`
by default, so a *future* event type gets this behavior automatically rather
than by someone remembering to special-case it. The ring is 8 entries per
conversation (`HEADS2_RING`), separate from the 16-entry `heads` ring
(`BEACON.headsRingSize`).

The plan's own §0 stated the reason incorrectly, and the mistake was caught and
corrected during the review round: it said a `.vot.e1` filename sitting in
`heads` would cost a 1.2 reader a full `catchUp` per bump, because that reader
could not parse the name. **That is not what the code does, and never was**:
`ingestHeads` skips a filename it cannot parse — `if (!parsed) continue` —
*before* the gap-detection check, in 1.2 exactly as in 1.3, so an unparseable
name in `heads` costs that reader no scan and no read, by itself. The real cost
is the **ring**: `heads` holds a fixed 16 names per conversation, and votes are
the one event type that arrives in a *burst* — a poll with a dozen voters would
push every real `msg` filename out of that ring before an older reader's next
poll, and that reader would then have to fall back to its bounded day-directory
scan to discover those messages instead of reading them straight off the
beacon, which is exactly the cheap path `heads` exists to provide. A second
field costs an older reader nothing at all, because an unknown top-level field
is not a name it has to make sense of — it is one it never looks at. This is
the identical argument 1.2 already made for `grpHeads`, one release earlier
(and that entry's wording has since been corrected too — see
`docs/contract-changes-1.2.md` and the note in `CLAUDE.md`).

**Compatibility with 1.1/1.2.** A pre-1.3 client has no `'poll'` `MsgBody.kind`,
so `RichContent` falls through to plain text and renders `MsgBody.text` — which
is why every poll's `text` field is always populated with `pollFallbackText`:
`"📊 Poll: <question> — update Chat to vote"`. It shows that one line and
nothing else: no options, no tile, no way to vote. A `.vot.e1` filename fails
both 1.1's and 1.2's `EVENT_RE` outright (neither recognizes the `vot` event
type), so it is skipped in silence on every scan — no error, no blank row,
nothing. `heads2` is an unknown field to both older readers and is ignored the
same way `app` and `grpHeads` already are.

### On-share layout

No new directory. A vote is an ordinary event file,
`<hlc>-<ctr>-<dev8>.vot.e1`, inside whichever conversation's log the poll
message lives in (`channels/`, `dm/`, or `groups/`) — same shape and same
retention (180 days) as any other event.

### Bridge

```ts
chat.vote(conv: ConvId, target: string, choice: string[]): Promise<void>
chat.closePoll(conv: ConvId, target: string): Promise<void>
```
`SendDraft.kind` gained `'poll'`; `SendDraft.poll?: PollBody`.

### UI

Composer gains a **Poll** button next to Diagram (`src/renderer/src/poll/
PollButton.tsx`, its own file for the same reason `DiagramButton.tsx` is —
`Composer.tsx` takes one import and one line) opening `PollDialog.tsx`: question,
2–10 options (add/remove, Enter on the last one adds another), a **Quick
decision** toggle that swaps the options for the Yes/No/Abstain preset and sets
`decision: true`, **Multiple choice**, **Anonymous** (with the "still signed on
the share" note inline), and a **Closes in** radio group (No deadline / 1 hour /
4 hours / 24 hours). `PollTile.tsx` draws one row per option with a fill bar,
count and percentage, the current device's pick highlighted, voter names below
each row unless the poll is anonymous, a countdown line while a deadline is
live, `Decided: …` once a decision poll closes, and a **Close poll** button for
the author while it's still open. Clicking an option votes (single-choice:
replaces the pick, or clears it if it was already the pick; multi-choice:
toggles); a closed option row stays keyboard- and screen-reader-reachable
(`aria-disabled`, not `disabled`) so a finished poll's result remains readable
without a mouse.

## 2. Live boards

### Design

A live board is a real-time Excalidraw session carried entirely by the shared
folder — built like the 1.2 screen-share relay, not like a conversation log —
under `boards/<sessionId>/<deviceId8>.<seq base36>`: one file per participant,
the sequence number in the filename, and the writer deletes its own previous
file immediately after publishing the next one. That layout is the whole design:
a single `readdir` of the session directory shows every participant's latest
state, which is what makes a joiner's first read the entire session and keeps a
live board's ongoing cost to one directory listing per poll tick.

**Frame format.** Each participant's frame (`BoardFrame`, extending
`BoardFrameDraft`) carries their **full** element list — not a diff — because
Excalidraw keeps `isDeleted` tombstones on every element it ever had, so a full
list reconciles cleanly through Excalidraw's own `reconcileElements` no matter
what order frames arrive in. It also carries any binary `files` introduced since
the writer's last frame, the writer's pointer (`{x, y, tool}`), and its current
selection. `BoardFrameDraft.elements` is spelled required in `shared/types.ts`,
but a **pointer-only** frame — sent from `onPointerUpdate`, up to four times a
second — deliberately omits it entirely: shipping the whole element list at
that rate is what made a large scene visibly flash on every *other*
participant's canvas on every cursor move (never on the sender's own, which is
why this survived the first review pass). Main already treats the field as
optional in every place that matters (`contentSignature`, `fitFrame`,
`publishPresence` all read `draft.elements ?? []`), and a receiver's
`digestFrames` simply builds no reconcile batch for a frame carrying none — the
type was left alone rather than loosened mid-review, since the shape already
travels safely both ways.

**AAD and kid, with the group epoch.** A frame is signed then encrypted under
the *conversation's* key — a channel, a DM, or a private group, whichever
`convInfo(conv)` resolves — with AAD binding it to its exact path and filename
(`buildAad('board', rel, fileName)`), so a frame moved into another session's
directory or renamed into another device's slot fails authentication before
anything inspects its contents. The kid is `KID.board(sessionId, convKid)` —
notably **not** just the session id, which is what the plan originally
specified. The conversation's own kid rides along because, for a private group,
that kid names the current *epoch*: a reader who has not yet been handed a
rekey (the rekey DM may simply not have arrived yet) needs to be able to tell
"wait and retry" apart from "this is garbage," and only the kid says which.
Without the epoch riding along, one membership change mid-session silenced the
whole board for everyone still in it, because every reader answered "junk" to a
frame it simply hadn't been given the key for yet.

**Session id, bound to the host's device.** A session id is the host's own
`deviceId8` (8 hex characters) plus 4 random bytes, 16 hex characters in total
(`SESSION_ID_RE`) — the review round tightened this from the plan's plain "16
random hex," specifically so the id itself proves who may speak for the session:
a `board-live` (or `board-ended`) whose announced or ended session id does not
begin with its own signer's device id is refused outright, which is what stops
a forged or duplicate announcement from stealing the host seat — and with it,
the exclusive right to end the board. The id is also a raw path segment
(`boards/<sessionId>/…`), so its shape is validated at *every* `boards:*` IPC
entry point and again inside the service itself, because a `..` smuggled through
it would otherwise walk straight out of the share root.

**The host is the *signer*, never the announced field.** `SysPayload`'s
`board-live` carries `{sessionId, boardId?, title, host, startedAt}`, and
`host` is what the UI labels the session with — but it is not what decides who
may end it. `BoardService` records `event.author`, the device whose signature
the ingest path already verified, and treats that as the one and only host;
`data.host` is a field any member's client could put any device id into, and
"who may end this session for everyone" was never a question worth answering
from an unauthenticated field. The two agree in every real session; nothing
about the wire shape or the UI needed to change to make this true.

**Exactly-once delivery, with a rejected-set fallback.** A reader's cursor per
peer device (`seqByDevice`) only ever advances on a frame whose verdict is
`'ok'` — verified signature, matching device claims across the filename/
signer/frame-body triple, and a `seq` inside the frame that agrees with the one
in its own filename. Two other verdicts leave the cursor exactly where it was,
so the next poll retries: `'gone'` (the writer's own delete landed mid-poll —
normal, not news) and `'pending'` (no key for this frame's epoch yet — a group
rekey may simply still be in flight). A `'refused'` verdict — a signature or
shape that will never become valid, since the AAD binds the file to this exact
name — is remembered in a small, bounded (64-entry, FIFO) per-reader set so a
single junk file costs one read, once, rather than being retried forever *or*
permanently muting the rest of that device's session (an early version had
exactly that bug: one bad file at a high sequence number was the only candidate
considered for that device, so the cursor advanced past it and every subsequent
real frame from that peer was silently never delivered). The reader walks a
device's candidate files newest-seq-first until one is good, rather than only
ever looking at the single newest file.

**Seq seeding after a restart.** A writer that rejoins — or crashes and comes
back — used to restart its sequence counter at 0, which every peer still in the
session had already delivered and would therefore never re-read. `seedWriter`
now reads the session directory once, before the writer's first publish of this
run, takes the next sequence number as one past the highest it already owns
there, and deletes anything it finds left over from a previous run (a crash
between publish and delete-previous can leave two of its own files in the
directory at once). Readers compare cursors with `!==` rather than `>=`
specifically so a writer's legitimately *lower* post-restart sequence still
reads as news rather than as a duplicate to ignore.

**Coalescing, pointer-only frames, keepalive, and tiers.** `write()` never
publishes synchronously — it queues the latest draft and a timer flushes at
most once per `BOARD.writeMinMs` (1 s) when the scene actually changed, or at
most once per `BOARD.pointerMinMs` (2 s) when only the pointer/selection moved.
Because main keeps only the *latest* queued draft per window, a scene edit
followed within that window by a pointer move can have its content silently
dropped in favor of the pointer-only draft that superseded it in the queue — so
the renderer follows a pointer burst with one scene "catch-up" frame after
`BOARD.writeMinMs * 2`, but only when a real content frame went out inside the
last write window; moving the cursor around a scene nobody is actively editing
still costs exactly one pointer-only frame, since main sees an unchanged content
signature and writes nothing extra. A keepalive frame re-sends the last
published frame every `BOARD.keepaliveMs` (10 s) even when nothing changed, so
that a participant who is only reading — or thinking — doesn't silently age out
of everyone else's pointer list. Readers poll the directory every
`BOARD.pollFocusedMs` (1 s) or `BOARD.pollBlurredMs` (3 s) depending on the
window's I/O tier *while the live editor is open* — the `idle` tier maps
explicitly to the blurred cadence, since an open live editor is itself a
statement that someone is watching — and `paused` (locked/suspended) stops all
board I/O outright, with the poll timer re-arming on its own once the tier
recovers, no rejoin required.

**The join presence frame.** `join()` publishes one content-less frame
immediately, before the caller has drawn anything, because the keepalive above
is only ever armed by a prior publish — without this, a pure watcher who never
touches the canvas was invisible in everyone else's pointer list for the whole
session.

**`droppedFiles` and `maxElements`.** `fitFrame` keeps a draft inside
`BOARD.maxFrameBytes`: it drops newly-introduced `files` first (an image can be
re-sent; a peer missing one still renders every shape) and only throws
`frame-too-large` if the scene is still over budget with no files left to
drop — never publishing a half-scene, since a partial element list reconciles
into every peer's canvas as *deletions*. The budget check is against
`JSON.stringify(draft)` plus a fixed 512-byte allowance for the envelope fields
the service adds (`sessionId`, `device`, `name`, `seq`, `at`) and the signature
wrapper — measured on the plaintext draft, deliberately, because measuring the
finished ciphertext would mean signing and encrypting a scene only to throw it
away, once per rejected write, on a whiteboard's hot path. The file that
actually lands on the share is larger still — base64, the SFC1 envelope's own
header/kid/salt/nonce/tag — so a 2 MiB budget is roughly a 2.7–3 MiB file at the
worst end, at most one such file per participant per `BOARD.writeMinMs`.
`write()` resolves `{ droppedFiles: string[] }` (bridge-additive) so the caller
can put those file ids back in its outgoing set for a later frame instead of
leaving a peer with a shape whose image never arrives — `live.ts`'s
`keepPending`/`selectNewFiles` do exactly that, and because main keeps only the
*latest* draft per write window, a freshly-sent file id is deliberately kept in
the outgoing set for one extra coalescing window (`BOARD.writeMinMs * 2`) after
being sent, in case the frame carrying it was itself superseded before the share
ever saw it. Separately, `BOARD.maxElements` (5000) is refused outright with
`frame-too-large` rather than silently clamped: receivers already cap incoming
scenes at the same number, so without this the *sender* had no way to learn
that a runaway scene was being silently truncated on every other participant's
screen.

**Lifecycle.** `start(conv, title, boardId?)` — host only in the sense that
whoever calls it becomes the host — refuses a `team:` conversation (no members
to collaborate with, and the janitor never sweeps `team/`, so a board there
would be a directory nobody ever cleans up) and refuses a second session this
same device is still live in (reading or writing) in the same conversation; it
creates the session directory *before* publishing the `board-live` sys event,
so a peer that reads the event immediately cannot race an `ENOENT` into reading
the session as already ended. `join(sessionId, conv)` reads every current frame,
starts the poller, and publishes the presence frame described above — a
re-join always answers with the whole session rather than "nothing new," since
the caller is rebuilding its canvas from scratch. `leave(sessionId, conv)` stops
polling and deletes the device's own file, idempotently. `end(sessionId, conv,
resultStem?)` is host-only (checked against the recorded event author, not
`data.host`), publishes `board-ended {sessionId, boardId?, resultStem?}`, and
removes the directory — `resultStem`, when given, must look like an actual
event stem (`RESULT_STEM_RE`), since it names a message every member will look
up as the board's "final version." A `board-ended` naming a session id nobody
has announced yet is deliberately **never allowed to mint an entry** for that
id — an earlier version let it do exactly that, which meant a stray ending
could pre-block a session id before its real `board-live` had even been
published, and the real announcement then found the id "already ended."

**`board-ended` authority.** Only the device recorded as the session's host —
the verified signer of its `board-live` — may end it; `boards.end` from anyone
else is refused with `not-host`, and the fold applies the identical rule on the
reading side (`onEvent`/`resolve` in `boards.ts`, and `foldBoardEvents` in the
renderer's `live.ts`) so a member cannot take the **Join** button away from a
board that is still running by publishing their own `board-ended` for someone
else's session.

**Janitor: dead and hard limits, read from the frames.** A session directory
is swept as *dead* once its **newest** frame's mtime is older than
`RETENTION.boardsDeadMinutes` (10 minutes) — or, for a directory that is still
empty (created by `start` before anyone has drawn), once the directory's own
mtime passes that same threshold, since an empty directory has no frame to
read. It is swept as *hard-expired*, unconditionally, once its **oldest**
still-present frame's mtime passes `RETENTION.boardsHardHours` (24 hours). Both
limits deliberately read frame mtimes rather than the directory's own: every
publish (a rename in) and every delete-previous inside a live session bumps the
directory's mtime constantly while anyone is drawing, so a directory-mtime-based
hard limit could never fire at all for an active board. An old version of the
sweep test only passed because its fixture back-dated the directory itself
after writing files into it — a state the real share can never produce.

**Measured cost.** The contract doc's "co-presence metadata" entry measures a
three-person live board at roughly **7 share operations a second per
participant** while the session is running — one directory listing per poll
tick plus reads of whichever peers' frames actually advanced, plus that
participant's own write or keepalive — and **zero** once nobody has an editor
open on it (the directory is gone, or nobody is polling it). This is the only
concrete steady-state number the contract doc measures; a finer breakdown
between "actively drawing" and "editor open but idle" was not something this
review could confirm anywhere in the code or in `contract-changes-1.3.md` — see
the caller's report for that gap.

**The byte-budget note.** See "`droppedFiles` and `maxElements`" above: the
2 MiB `BOARD.maxFrameBytes` is a budget on the plaintext draft plus a fixed
envelope allowance, not on the file that lands on the share, which runs
roughly 2.7–3 MiB at the worst case once signing, base64, and the SFC1 envelope
are accounted for — at most once per participant per `BOARD.writeMinMs`.

**The co-presence-metadata decision.** `boards/<sessionId>/<deviceId8>.<seq>`
is *deliberately* readable, as filenames, by anyone on the share: any team
member can list the directory and learn which devices are in a live session and
roughly how fast each one is writing. That is the price of the property the
layout exists to provide — one `readdir` reveals every participant's latest
state, which is what keeps a joiner's first read cheap and a three-person
board's ongoing cost to the ~7 ops/s above. What stays completely hidden is
everything *inside* the files: the frames are sealed under the conversation's
own key, so a team member outside a DM or private group learns nothing about
what is being drawn, what the board is titled, or which conversation it
belongs to — the session id itself is random, and the `board-live` announcement
that ties it to a real conversation lives inside that conversation's own
encrypted log. The alternative — a per-participant opaque token derived from
the conversation key, so even the *slot* is unreadable to an outsider — was
considered and rejected: it costs a fresh derivation per participant per
session and buys nothing for the DM and private-group cases, where conversation
membership already bounds who can see the directory's existence at all.
Screen-share sessions made the identical trade under `screens/` in 1.2.

**What a 1.2 client sees.** `board-live`/`board-ended` are new `SysPayload`
kinds; a 1.2 client's `sysLine()` already has a `default` branch (added in the
1.2 review round for exactly this situation) and renders both as one neutral
line, "something changed in this conversation," with no **Join** button and no
way to open the board — the plan's own §0 described this fallback loosely as
"…", but the actual shipped default-branch text is the sentence above (see
"contradicts the plan," below). A 1.2 client never lists `boards/` and its
janitor never sweeps it (`SWEEP_EVENT_ROOTS` has no entry for `DIR.boards`), so
a session's directory is only ever cleaned up once a 1.3 client's janitor wins
the daily claim. A 1.1.x client has no `default` branch in its `sysLine()` at
all (that was itself a 1.2 review fix), so both kinds fall off the end of its
switch, return `undefined`, and draw a blank centered row — the same latent
1.1 behavior every 1.2-or-later addition to `sys` already has.

**The renderer flow: restore → reconcile → `updateScene` NEVER.** Inbound
frames (`digestFrames` in `live.ts`, pure and DOM-free) keep only the newest
frame per remote device from a delivery and collect every `files` entry across
all of them (a binary file rides the wire once, by whichever frame first
carried it). `useLiveBoard.ts` then runs each batch's raw element array through
Excalidraw's own `restoreElements` (drops element types this build cannot
draw, de-duplicates ids, repairs a bound arrow whose other half never arrived)
before handing it to `reconcileElements` — Excalidraw's own per-element
last-writer-wins by `version`/`versionNonce` — accumulating across every batch
in a delivery, and finally applies the result with `api.updateScene({ elements,
captureUpdate: CaptureUpdateAction.NEVER })`. `NEVER` is load-bearing: a peer's
stroke must never land in this user's own undo stack.

**The echo guard.** After a remote frame is applied, its reconciled scene's
signature is recorded as *both* `liveSig` (what this device believes the scene
now is) and `remoteSig` (what a peer just put there) — the `onChange` that
Excalidraw itself fires for its own `updateScene` call then compares against
`liveSig`, finds no difference, and writes nothing back out; `isRemoteEcho`
exposes `remoteSig` to the editor so it can also tell a spectator's "unsaved
work" confirm apart from a peer's own edit — someone who only ever watched a
board must never be asked whether they want to keep drawings they never made. A
genuinely local edit landing in the same tick changes the signature again and
does get written.

**Collaborators.** The participant map built from `board-frames` deliveries
feeds Excalidraw's own collaborators API: a stable color per device (an
avalanche-mixed FNV-1a hash into an 8-color palette, chosen from the id rather
than a join order so the same person is the same color on every participant's
screen), a name resolved from this device's own roster/presence first and the
frame's self-declared name only as a fallback (a frame's name field is
self-declared and not worth trusting over an identity this device already
has), and the pointer/selection passed straight through. A participant who
stops publishing — closed their editor, lost the share — ages out of the map
after `BOARD.staleMs` (30 s) on a five-second sweep, since nothing else will
ever evict them.

**Live draft slots.** The per-editor-slot autosave (`drafts.ts`, from 1.2)
deliberately never shares a live board's key with the conversation's ordinary
"new diagram" draft: a join is keyed `live:<sessionId>` and a hosted start is
keyed `live:new`, both distinct from the plain `new` slot a private, unsent
diagram would otherwise occupy. Joining a board must not publish someone's
unsent private drawing to everyone, a join's opening scene must come only from
the session's own frames (never from a stale `localStorage` entry), and a
board's draft — while still autosaved, since a crash mid-session shouldn't lose
work either — is never *reopened* on the next join, and every live draft but the
currently-open one for a conversation is pruned on each save so an endless
sequence of joined boards doesn't slowly fill the quota.

**`pagehide` leave.** Closing the editor normally gives up this device's frame
file so peers don't wait out `BOARD.staleMs` for a stale pointer to disappear.
A reload (⌘R, renderer crash-recovery) or a window close tears the React tree
down without running unmount effects, so `useLiveBoard.ts` also listens for the
window's own `pagehide` event and leaves from there, fire-and-forget — main's
`mainWindow.on('closed')` handler (which stops every board session the whole
process is in) covers a genuine window close, but a reload keeps the renderer
process alive, so this is the other half of the same guarantee.

### On-share layout

```
boards/<sessionId>/<deviceId8>.<seq base36>
```
Created by `start()` before its `board-live` announcement publishes; removed by
`end()` (idempotent) or by the janitor once a session goes dead or hits the
hard limit. No metadata file — the `board-live` sys event in the conversation's
own log is the session's only source of truth for its title, host, and
creation time.

### Bridge

```ts
boards: {
  start(conv: ConvId, title: string, boardId?: string): Promise<{ sessionId: string }>
  join(sessionId: string, conv: ConvId): Promise<{ frames: BoardFrame[] }>
  write(sessionId: string, conv: ConvId, draft: BoardFrameDraft): Promise<{ droppedFiles: string[] }>
  leave(sessionId: string, conv: ConvId): Promise<void>
  end(sessionId: string, conv: ConvId, resultStem?: string): Promise<void>
}
```
Plus pushes `{ kind: 'board-frames'; sessionId; frames }` and `{ kind:
'board-ended'; sessionId }`. `SysPayload.kind` gained `'board-live'` (`data:
{sessionId, boardId?, title, host, startedAt}`) and `'board-ended'` (`data:
{sessionId, boardId?, resultStem?}`).

### UI

The diagram editor's header gains a **Live** pill (`LiveChrome.tsx`) —
"Start live session" before there is one, then the pill with up to three
participant avatars/names and a `+N` overflow, and the host's **End session**
button. `LiveEndedBanner` replaces the pill once the host ends a board the
local editor is still open on ("The host ended this live board. Your copy is
still here…"), and `LiveCloseDialog` gives the host three answers when closing
an editor on a still-running board — End for everyone, Keep it running (leave
only), or Cancel — since Esc and the backdrop both mean the least destructive
of the three. A diagram tile's **Collaborate** action hosts a new session
seeded with that message's scene; a `board-live` sys row renders a **Join**
button for as long as the registry (`foldBoardEvents` in `live.ts`, fed by the
store) considers that session still alive.

## 3. Whole-window editor

### Design

The diagram editor overlay was already `position: fixed; inset: 0`, so "whole
window" here means real OS fullscreen, not a CSS change: `app.setFullScreen`/
`isFullScreen` toggle it from the editor's header, and `mainWindow`'s own
`'enter-full-screen'`/`'leave-full-screen'` events push a `{ kind: 'fullscreen';
on }` message back to the renderer so the header reflects reality even when
fullscreen is left some other way — a system gesture, or the macOS traffic-light
green button. In fullscreen the header collapses from 52 px to a slim 36 px
strip (title, the Live pill slot, any queued note, the fullscreen toggle, Send,
Close); the canvas below takes the rest of the window in both states, since
nothing in the overlay's chain carries a max-width.

**The chord.** F11 toggles it on Windows/Linux; macOS reserves F11 system-wide
for Show Desktop, so the editor listens for **⌃⌘F** there instead — the same
chord Finder and Mail already use for their own fullscreen
(`fullScreenKeyLabel`/`isFullScreenToggleKey` in `diagram/fullscreenKey.ts`,
pure and unit-tested without mounting Excalidraw; Shift or Alt held rules the
chord out, so a future `⌃⌘⇧F` is never misread as this one). Unlike the
editor's ordinary Esc handling — which explicitly bails out when the event
target is inside `.excalidraw`, since Excalidraw owns Escape for itself there —
the fullscreen chord does **not** follow that rule and is captured at the
window level regardless of where the cursor or focus is: the canvas is where
the pointer lives for the entire time anyone would reach for this chord, and
Excalidraw separately claims ⌃⌘F for its own element-search panel, so bailing
out inside `.excalidraw` meant the chord opened Excalidraw's search instead of
toggling fullscreen, and F11 silently did nothing at all.

**Esc order.** A confirm dialog (the close-confirm, the live "end for
everyone" dialog) swallows the first Escape for itself; failing that, the
export menu closes on Escape if it's open; failing that, Escape inside
`.excalidraw` belongs to Excalidraw itself (it leaves a text element being
typed, drops a selection, closes a shape-library panel) — **except** while the
editor is fullscreen, where the canvas fills the entire screen and Escape from
inside it is the only exit a person will actually look for, so it is *not*
swallowed there (still excluded while Excalidraw itself is mid-text-edit or
holding one of its own dialogs open, which still have something of their own to
dismiss). Outside all of those cases, Escape leaves fullscreen first if the
editor is in it — a second Escape then closes the editor, the identical
two-step already used for a confirm dialog eating the first Escape.

**The intent ref.** Whether *closing the editor* also takes the window back out
of fullscreen is decided by the editor's own intent (`weWentFs`, a ref set only
when this editor's own `setFullScreen` call requested `true`), never by the
store's `fullscreen` flag. The flag is a push from `mainWindow`'s native event
and lands a beat after the request, so reading it at unmount would misjudge a
close that happens mid-transition; and a window the user had already put into
fullscreen *before* ever opening a diagram is equally not this editor's state to
undo when it closes — `fsAsked`/`weWentFs` are reconciled against
`window.bridge.app.isFullScreen()` on mount specifically to tell those two
cases apart.

### Bridge

```ts
app.setFullScreen(on: boolean): Promise<void>
app.isFullScreen(): Promise<boolean>
```
Push: `{ kind: 'fullscreen'; on: boolean }`.

### UI

A header button (expand/collapse icon, `aria-pressed`, tooltip showing the
platform's chord label) toggles it; Export ▾ and Import… hide themselves in the
36 px fullscreen header to make room, and the title/Live-pill/Send/Close set
stays.

## 4. Tests

**Shared/protocol:**
`src/shared/poll.test.ts` ("the pre-1.3 fallback line", `validatePollDraft`,
`normalizePollBody`, "closing" — `calibrateClosesAt`, `checkChoice`);
`src/shared/merge.test.ts` ("poll votes" — LWW per device, retraction,
close-finality and the 5 s grace, id-order tie-breaking; "edits from someone who
is not the author" — the target-and-author edit key); `src/main/transport/
shareIo.test.ts` ("share paths" — `abs()` refusing `..`/`.`/empty segments/
backslash, and the share-root `listDirs('')` fixup).

**Main-side live boards:** `src/main/services/boards.test.ts` ("board frame
writing" — coalescing, pointer-only vs content frames, keepalive, frame-too-
large, dropped-files reporting; "board session lifecycle" — start/join/leave/end,
one-live-session-per-conversation, refusing a `team:` conversation; "board writer
identity across restarts" — seq reseeding, stale-file cleanup; "board session
ids and conversation binding" — `SESSION_ID_RE`, `conv-mismatch`, host-only
`end`, ignoring a `board-ended` from a non-host, never minting a session from an
ending alone; "board writing against a share that moved"; "the janitor sweeps
board sessions" — dead-from-newest-frame, hard-from-oldest-frame, the empty-
directory case; "board frame helpers" — `contentSignature`/`pointerSignature`/
`fitFrame`). `src/main/transport/integration.test.ts` ("live boards over a
shared folder" — two/three-client frame exchange, exactly-once delivery, a
non-member's inability to decrypt, a rekey mid-session keeping the board opaque
to a non-member and readable across the rotation, a forged `device` dropped)
and "poll votes over a shared folder" (heads2 routing end to end, a 1.2 reader's
leniency toward the unknown field, vote/close/late-vote-refusal across two
clients).

**Renderer live boards:** `src/renderer/src/diagram/live.test.ts`
(`boardColor` stability, `digestFrames`, `pruneParticipants`, "the echo guard",
`selectNewFiles`/`keepPending` — the file re-send window, `foldBoardEvents`/
`endBoardIn` — the session registry and its ended-tombstone rule, `boardJoinAction`).
`src/renderer/src/diagram/drafts.test.ts` covers the live-slot additions
(`draftSlotOf`/`draftRestorable` for `live:new`/`live:<sessionId>`, and "live
drafts do not pile up" — `pruneLiveDrafts`).

**Polls UI:** `src/renderer/src/poll/polls.test.ts` (`tallyPoll`,
`decisionOutcome`, `nextChoice`, "countdown" — `closesInLabel`/
`countdownTickMs`). `src/main/services/chatService.test.ts` ("polls" — send
with a calibrated deadline, vote validation, close authorization and
idempotency).

**Fullscreen:** `src/renderer/src/diagram/fullscreenKey.test.ts`
(`isFullScreenToggleKey` per platform and modifier combination,
`fullScreenKeyLabel`). `src/renderer/src/store/index.test.ts` ("store:
fullscreen push").

**E2E (`scripts/e2e-drive.mjs`):** a poll section sends a quick-decision poll
from Alice, confirms Bob's copy carries the `PollBody` and the pre-1.3 fallback
line, has Bob vote and confirms a single-choice second pick is refused, confirms
Alice's raw event log shows Bob's `vot` event (proving `heads2` routing worked
end to end), confirms only the poll's author may close it, closes it, confirms
Bob's copy shows `closedAt`, and confirms a vote cast after the close is
refused. A live-boards section has Alice start a session, confirms Bob's log
carries the `board-live` sys event, has Alice join her own session (the poller
only starts on join), writes a two-element scene, has Bob join mid-session and
receive it, has Bob write a third element and confirms Alice receives it via a
`board-frames` push, confirms `boards/<sid>/` on the real share holds exactly
one file per writer, confirms `boards.end` from a non-host is refused, has
Alice (the host) end it, confirms Bob is told (push or sys event) and that the
directory is gone — plus a UI-driven pass that clicks a tile's **Collaborate**
button, confirms the participant `aria-label` updates, confirms the editor's
own frame reaches the real `boards/<sid>/` directory, drives a second bridge
client through join/write/leave against that same UI-hosted session, and clicks
the header's **End session** button to confirm the directory disappears.

## 5. Compatibility summary

Nothing in 1.3 changes the envelope format, key derivation, or any existing
on-share file's shape. A 1.1.x or 1.2 client needs no code to keep working
against a 1.3 teammate:

- A poll message shows only its pre-1.3 fallback line ("📊 Poll: … — update
  Chat to vote"); its `.vot.e1` vote files fail both older clients' event-
  filename regex and are skipped without a trace.
- `heads2` (plain and inside the sealed DM/group sections) is an unrecognized
  top-level field that both older readers' beacon parsing simply never reads —
  the same mechanism 1.2 already used once for `grpHeads`.
- `boards/` is an entirely new top-level directory that an older client's
  poller never looks inside and an older client's janitor never sweeps
  (`SWEEP_EVENT_ROOTS` has no entry for it until 1.3).
- `board-live`/`board-ended` are new `sys` kinds: a 1.2 client already has a
  `default` branch in `sysLine()` (a 1.2 review fix) and renders both as one
  neutral line with no way to join; a 1.1.x client's `sysLine()` predates that
  default branch and draws a blank centered row for both, the same latent gap
  every `sys` addition since 1.2 already has on a 1.1.x client.
- The whole-window/fullscreen editor and its OS-level toggle are entirely
  local to the machine that opens a diagram; they have no share-visible
  footprint at all.

## Claims not confirmed in code, and discrepancies from the plan

- **The plan's "1.2 clients show board-live/board-ended through sysLine's
  default branch ('…')" is imprecise.** The actual shipped default-branch text
  (`src/renderer/src/chat/util.ts`, `sysLine()`) is `"something changed in this
  conversation"`, not the literal string `"…"`. Likely the plan meant the
  default branch loosely rather than quoting its exact copy, but this document
  states the real text since an agent reading `sysLine()` for the first time
  would otherwise expect to find a literal ellipsis case.
- **Per-participant cost, measured** (review round, three real clients, real
  timers): actively drawing ≈ 4.9 ops/s (≈ 5.9 on a share with 250 ms write
  latency), idle with the editor open ≈ 1.3 ops/s (the 1 s directory listing),
  zero once the editor is closed. The "~7 ops/s" figure used above is the
  upper bound. Details in `docs/contract-changes-1.3.md` ("co-presence
  metadata" entry).
- **The task's "fix batches FP, FR, FM"** — only **"Batch FR"** entries
  actually appear in `docs/contract-changes-1.3.md` (the `HealthView.offsetMs`
  addition and the pointer-only-frame-carries-no-`elements` entry). No entry in
  that file is labeled "Batch FP" or "Batch FM"; every other post-plan change in
  the file is attributed to a lettered *stream* (A/B/C) or to an unlabeled
  "review round" rather than a lettered fix batch. This document treats every
  dated entry in the file as authoritative regardless of its batch label, per
  the instruction that the file wins over the plan, but the FP/FM batch names
  themselves do not appear anywhere in the repository.
