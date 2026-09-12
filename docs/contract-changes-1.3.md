# Contract changes during 1.3 implementation

Deviations from the contract described in §1 of the approved 1.3 plan. Each
entry says what moved, why, and what a reviewer should check.

---

## 2026-09-12 — a live board's host is the *signer* of `board-live`, not its `data.host`

**Stream A (live boards, main side).** `SysPayload` `board-live` carries
`{sessionId, boardId, title, host, startedAt}`, and `host` is what the renderer
labels the session with. It is not what decides who may end it:
`BoardService` records `event.author` — the device whose signature the ingest
path already verified — and refuses a `board-ended` from anyone else, plus its
own `end()` from a device that is not that author. `data.host` is written
truthfully by every client we ship, but it is a field a member could put any
device id into, and "who may end this session for everyone" is not a question
worth answering from an unauthenticated field. The two agree in every real
session; nothing in the contract or in the renderer changes.

Check: `boards.test.ts` → "ignores a board-ended from anyone but the host",
`integration.test.ts` → "ends for everyone when the host says so, and refuses
when anyone else does".

## 2026-09-12 — `BOARD.maxFrameBytes` is measured on the draft plus a fixed envelope allowance

**Stream A.** The budget is checked in `write()` — before the frame is queued,
so the caller gets `frame-too-large` synchronously rather than from a timer it
cannot see — against `JSON.stringify(draft)` plus 512 bytes for the fields the
service adds (`sessionId`, `device`, `name`, `seq`, `at`) and the signature
wrapper around them. Measuring the finished ciphertext instead would mean
signing and encrypting a scene only to throw it away, once per rejected write.
The practical limit is therefore `maxFrameBytes - 512`, and `files` are dropped
before the frame is refused (a peer missing an image still renders every shape;
a peer missing *elements* reconciles the gap as deletions).

## 2026-09-12 — `boards:*` stubs removed, and with them `ipc.ts`'s `notImplemented` helper

**Stream A.** The five `boards:*` handlers now register from
`services/boardsIpc.ts` (called at the bottom of `registerIpc`, like
`registerScreenIpc`). That was the last of the 1.3 stubs — polls and the
fullscreen toggle had already replaced theirs — so the `notImplemented` helper
had no callers left and `noUnusedLocals` would have failed the build for
everyone. It is gone; the comment above the block says so.

## 2026-09-12 — new file `src/shared/poll.ts` (poll helpers, both processes)

**Stream C (polls).** The plan lists the pure poll logic under
`src/renderer/src/poll/polls.ts`. Part of it cannot live there: the main process
needs the same answers the renderer does, and main must not import out of
`src/renderer`.

Split, exactly like 1.2's `shared/diagram.ts` vs `renderer/diagram/*`:

- `src/shared/poll.ts` — what both sides must agree on: the pre-1.3 fallback
  line (`pollFallbackText` / `pollQuestionOf` / `pollPreview` /
  `pollNotifySnippet`), draft validation against `POLL_LIMITS`
  (`validatePollDraft`), body normalization including option-id generation
  (`normalizePollBody`), `isPollClosed`, `checkChoice`, `calibrateClosesAt`, and
  the `DECISION_OPTIONS` preset. Tested in `src/shared/poll.test.ts`.
- `src/renderer/src/poll/polls.ts` — the tile's arithmetic, as planned: tally,
  decision outcome, click-to-choice, countdown. Tested in `polls.test.ts`.

No wire-shape change: `PollBody`, `VotPayload` and `MsgBody.poll` are exactly as
§1 applied them.

## 2026-09-12 — `closesAt` is restated on the share clock by main

**Stream C (polls).** `PollBody.closesAt` is documented as share-calibrated ms,
but only the renderer knows what the author picked ("closes in 4 hours") and it
has nothing but `Date.now()` to express it with. `ChatService.send` therefore
keeps the *interval* and republishes it as `calibratedNow() + span`
(`calibrateClosesAt`), clamping the span to 1 minute … 30 days.

Why it matters: every reader — including the sender — decides "closed" by
comparing `closesAt` against the share clock. Without this, an author whose
machine is an hour ahead publishes a poll that others think closes an hour
early, and one whose machine is behind publishes a poll that is already closed
on arrival. Reviewer check: `calibrateClosesAt` in `shared/poll.test.ts`, and
"sends with … a calibrated deadline" in `chatService.test.ts`.

## 2026-09-12 — poll composer button in its own file

**Stream C (polls).** `src/renderer/src/poll/PollButton.tsx` (the toolbar
button + its icon + the dialog's open state) exists so `Composer.tsx` takes one
import and one line, the same shape `DiagramButton.tsx` has had since 1.2. The
plan says "`Composer.tsx` (Poll button next to Diagram)", which this is — just
not spelled inline.

## 2026-09-12 — `heads2` ring size and routing rule

**Stream C (polls).** §0 fixes the ring at 8 per conversation; that is what
`HEADS2_RING` in `beacon.ts` is. The routing rule is stated there as "`vot` (and
any type not in the 1.2 set)", and is implemented as an explicit allow-list of
the types a 1.2 filename regex can parse (`HEADS_1_2_TYPES`), so a *future*
event type lands in `heads2` by default rather than by someone remembering to
add it. `grp` stays in the sealed `grpHeads` ring it has had since 1.2 — a 1.2
peer already knows to read that one.

**Why a second field at all** (the §0 row said a `.vot.e1` name in `heads` would
make a 1.2 reader run a catch-up per bump; that is not what its code does, and
the comments that repeated it have been rewritten): `ingestHeads` skips a name it
cannot parse — `if (!parsed) continue`, before the gap check, in 1.2 exactly as
in 1.3 — so such a name costs that reader no scan and no read. The real cost is
the ring. `heads` holds `BEACON.headsRingSize` (16) names per conversation, and
votes are the one event type that arrives in a burst: a poll with a dozen voters
fills the ring and pushes every `msg` filename out of it before an older reader
next polls, leaving it to discover those messages on its next bounded day scan
instead of from the beacon — losing exactly the cheap path `heads` exists for.
A separate field gives votes their own budget and costs an older reader nothing,
because an unknown top-level field is one it never looks at. Same argument, one
version earlier, for `grpHeads`.

## 2026-09-12 — a live board's new `files` ride one extra coalescing window

**Stream B (live boards, renderer).** The plan says newly added binary files
travel "only once", and the editor tracks which ids it has sent. It keeps
sending each new id for `BOARD.writeMinMs * 2` anyway (`selectNewFiles` in
`diagram/live.ts`), because main keeps only the *latest* draft per write window:
a draft carrying an image that is superseded 200 ms later by a pointer-only
draft takes the image with it, and the receiver then draws that element as a
permanent blank. There is no ack to wait for, so the window is the ack. Cost is
a second or two of re-sent image bytes inside an already-bounded
`maxFrameBytes`; the alternative is an unrecoverable hole in someone else's
scene. Reviewer check: `live.test.ts` → "sends a file, keeps sending it through
the coalescing window, then stops".

## 2026-09-12 — the renderer store's `send()` resolves with the new event id

**Stream B.** `chat.send` on the bridge has always returned `{ id }`; the
store's `send()` threw it away. It now passes it through, so the host's "…and
end the session" after a Send can hand that id to `boards.end` as
`resultStem` — the plan's "optional post final version", which otherwise had no
way to name the version it was pointing at. Additive: every other caller
ignores the value. No bridge change.

## 2026-09-12 — poll merge rules: one vote per *device*, and a closed poll is final

**Stream C (polls), review fixes.** Three rules in `src/shared/merge.ts` that the
contract implies but never spelled out, plus one the reviewers found missing:

- **A vote is per device, not per person.** `MessageView.votes` is keyed by
  `deviceId`, so one human running Chat on a laptop and a desktop counts twice,
  and no client can tell that the two are one person — a roster record *is* a
  device, and nothing on the share binds devices to people. The team treats
  device = person, which is how reactions and read receipts have always counted
  too. A "one vote per human" poll would need an identity layer we deliberately
  do not have.
- **A closed poll's result is final.** `materialize` ignores any `vot` whose stem
  HLC is later than the poll's close — the author's `closedAt`, or the deadline it
  was published with (`closesAt`), whichever came first — plus a 5 s grace for
  votes already in flight when the author pressed Close. `chat.vote` refuses on
  both, so a later vote is one a client had no business writing. It keeps the vote that *stood* at closing time,
  so a retraction written after the close cannot walk back a decision that has
  already been announced ("Decided: Yes (4–1)" stays that). Before this, any
  reader who ingested the late event quietly showed a different result from one
  who had not.
- **Votes are last-writer-wins by event id, exactly like reactions.** A device
  whose clock runs behind the vote it wrote a minute ago publishes an event with
  a lower stem, and that event never lands anywhere — the stem is the only order
  every reader can agree on, so id-order LWW is the rule rather than arrival
  order. Same for its own retraction: it has to out-rank its own last vote.
- **An `edt` is keyed by target *and author*.** Only the message's own author can
  edit it, and the accumulator used to keep one edit per target, authorship
  checked at apply time: anyone on the share could write a later `edt` of their
  own, shadow the author's, and have the apply step refuse theirs and silently
  drop the real one with it. For a poll that meant a single unauthorized event
  re-opened a closed poll (closing *is* the author's `edt`).

Also `validatePollDraft` now returns `'poll-duplicate-option'` when two options
normalize to the same text (whitespace collapsed, trimmed, case-insensitive).
They would get distinct ids and split one answer across two rows — the poll that
was meant to decide something reports 3–3 between "Friday" and "friday ". Main
rejects it through the same validator the dialog uses.

Reviewer checks: `merge.test.ts` → "a closing edit by the author survives a
stranger's edit", "a vote cast after the poll closed is not counted", "a
retraction after the close does not flip the decision", "a vote with a lower stem
than this device's last one never lands"; `poll.test.ts` → duplicate options;
`chatService.test.ts` → "refuses a draft the limits do not allow".

## 2026-09-12 — `HealthView.offsetMs?` (additive): the share clock reaches the renderer

**Batch FR (renderer fixes).** `PollBody.closesAt` is share-calibrated ms — main
restates the author's interval on the folder's clock (`calibrateClosesAt`, above)
— and `isPollClosed` compares it against "now". The renderer had nothing but
`Date.now()` to compare with, so a machine whose clock was an hour fast closed
every timed poll an hour early (locally, for that person only: the tile went
grey, the countdown vanished, and main happily accepted the votes everyone else
was still casting). A machine running slow kept a finished poll open and had its
votes refused.

`HealthView` therefore carries an optional `offsetMs`: add it to `Date.now()` for
the share clock. `ChatService`'s `health` push fills it in from
`io.getClockOffsetMs()` when main has calibrated (absent before that, and from an
older main), and the store keeps the last value it was told rather than dropping
it when an unreachable-share push arrives with none. `PollTile` ticks and tallies
on `Date.now() + offsetMs`, which is the old behaviour exactly when the offset is
unknown (0).

Additive and optional: nothing else on `HealthView` changes, and every existing
reader (the share-health pill) ignores the field.

## 2026-09-12 — a pointer-only board frame carries no `elements`

**Batch FR (renderer fixes).** `BoardFrameDraft.elements` is spelled required,
and a frame written from `onPointerUpdate` deliberately omits it: the renderer
sends up to four pointer updates a second, and a whole element list at that rate
made a large scene flash on every *other* participant's canvas once per update
(never on the sender's, which is why it survived the first round). Main already
treats the field as optional — `contentSignature` reads `draft.elements ?? []`,
`fitFrame` the same, and `publishPresence` writes `{ elements: [] }` for a
watcher — and a receiver ignores a frame with no elements (`digestFrames` makes
no batch for it), so the shape travels safely in both directions. The type was
left alone rather than loosened mid-round.

One consequence is handled in the renderer: because main keeps only the *latest*
draft per write window, a pointer-only draft can replace a scene draft queued
moments earlier, and that scene would then reach nobody. `useLiveBoard` follows a
pointer burst with one scene frame (`CONTENT_CATCHUP_MS`) — but only when a
content frame went out inside the last `BOARD.writeMinMs`, so moving the cursor
around a scene nobody is editing still costs exactly one pointer-only frame. When
nothing was lost, main sees an unchanged content signature and writes nothing at
all.

## 2026-09-12 — live boards: the review round (stream A, main side)

**Stream A.** The fixes below all landed together after the 1.3 review; they are
one story, so they are one entry. Everything here is inside `boards.ts` /
`boardsIpc.ts` / `janitor.ts` / `shareIo.ts` unless it says otherwise, and the
renderer-visible surface changes in exactly two places (`KID.board`, and
`boards.write`'s result).

**A frame's kid now carries the conversation's kid.** `KID.board(sessionId)`
became `KID.board(sessionId, convKid)` — `board/<sid>/<the conversation's own
kid>`. A private group rotates keys under a stable conversation, so a frame can
be written under an epoch the reader has not been handed yet; without the epoch
in the kid the reader could not tell "wait for the rekey" from "this is junk",
and answered *junk* — one removal mid-session and the board went silent for
everyone still in it. Readers now park such a frame and retry it on later polls
(the same rule `events.ts` has applied to group records since 1.2). Check:
`integration.test.ts` → "keeps a private-group board opaque to a non-member, and
readable across a rekey".

**`boards.write` resolves `{ droppedFiles: string[] }`** (bridge, additive) and
`fitFrame` returns `{ frame, droppedFiles }`. Dropping `files` to fit the budget
was invisible to the caller, so the renderer believed it had sent an image it had
not, and the peer drew a permanent blank. `BOARD.maxElements` (5000) is new, and
`fitFrame` refuses a scene above it with `frame-too-large`: receivers already
clamped, silently, so a runaway scene published happily while every peer
truncated it.

**A session id is `deviceId8` + 8 random hex, and its shape is law.** The plan
said "16 hex"; it is still 16 hex, but the first eight are the host's device.
That binds a session to its creator: a `board-live` whose author does not own the
id it announces is ignored (which is what stopped a duplicate announcement from
taking the host seat, and with it the right to end the board), and so is an
unverified one. The review asked for `deviceId8 + randomBytes(6)`; that is 20
characters and the contract, the renderer and the existing fixtures all say 16,
so the random half is 4 bytes. 32 bits inside one device's own id space is not a
collision anyone can arrange. The shape is validated (`/^[0-9a-f]{16}$/`) at
every `boards:*` entry point *and* in the service, because the id is a path
segment: `boards/<sessionId>/…` with `../..` in it walked straight out of the
share root.

**`ShareIo.abs()` refuses unsafe paths for every caller** — `..`, `.`, empty
segments, absolute paths, backslashes. Board sessions (1.3) and screen sessions
(1.2) both put a bridge-supplied id into a path; the services validate them, and
this is the floor under all of them. One test called `listDirs('')` to list the
share root; the root is not a share-relative path and that call is now `'d'`.
Check: `shareIo.test.ts` → "refuses a path that could leave the share root".

**Sessions are keyed by `conv|sessionId`, and `board-ended` never mints one.**
An ending from a member who never announced anything used to *create* the
session entry, marked ended — pre-blocking any id it named, including one that
was about to be announced for real. Now an ending is only an answer about a
session we know, from the host we recorded. `write`/`leave`/`end`/`join` must
also name the conversation the session was started or joined in
(`conv-mismatch`): the frame's key and AAD both come from the conversation, so a
mismatched `write` would encrypt the board under a key its members do not hold.

**`start` refuses a `team:` conversation** (LWW app state, no collaborators, and
the janitor never sweeps `team/` — a board there is a directory nobody ever
cleans up) **and a second live board in the same conversation**, where "live"
means this device is still in it (a reader or a writer — which is what an open
editor holds, since the host joins its own session to see everyone else's
frames). A board the host has left is the user asking for a new one, not a
runaway.

**Writers seed their seq from the share; joiners publish one frame.** A writer
that rejoined — or crashed and came back — restarted at seq 0, which every peer
that stayed in the session had already delivered: its whole second run was
invisible. The writer now reads the directory once, deletes anything it left
behind (a crash between publish and delete leaves two files in one slot) and
continues from the highest seq it owns. Readers compare their cursor with `!==`
rather than `>=` so a legitimately lower seq is still news. And `join` publishes
one frame immediately: the keepalive is armed by a publish, so a participant who
only ever watched never appeared in anyone's pointer list.

**The reader walks every candidate in a device's slot, newest first.** Anyone in
the team can write a file into the directory — only the conversation key decides
what can be *read* — and one unreadable file at a high seq used to mute that
participant for the rest of the session: it was the only candidate considered,
and the cursor advanced past it even though the frame was refused. A refused
name is remembered (bounded, 64 per reader) and the reader falls through to the
next file; "could not decrypt yet" (a rekey in flight) and "gone" (a delete that
landed mid-poll) are *not* refusals and leave the cursor alone. A frame whose
own `seq` disagrees with the file name it sits in is refused.

**Lifecycle.** `BoardService.stop()` is now async, deletes this device's files
for every session it is in, and is owned by `AppController` — stopped in
`changeTeamFolder` and `shutdown` beside `chat.stop()`, and from the main
window's `closed` handler. A board's poller and keepalive exist to serve an open
editor; on macOS the process outlives the window, so they used to keep polling
(and writing into) a session with nobody to push to. The keepalive also obeys
the I/O tier now: paused skips and re-arms, like the poller. And `publishFrame`
treats a missing session directory as the end of the session rather than letting
`io.publish`'s `mkdir -p` resurrect a board nobody can close.

**Janitor: the hard limit is read off the oldest frame, not the directory.**
Every publish and delete inside a live session's directory bumps its mtime, so
the directory could never look older than a few seconds while anyone was drawing
and `RETENTION.boardsHardHours` could not fire at all. The oldest frame still in
the directory is the share's own record of how long the session has been going
(`board-live`'s `startedAt` says it too, but the janitor reads directories, not
conversation logs). An *empty* directory is still judged by its own mtime — it
is all there is. The old test passed only because its fixture back-dated the
directory after writing the files, a state the share cannot produce.

**Smaller ones.** `end`'s `resultStem` must look like an event stem
(`bad-result-stem`). `resolve()` caches misses, so `write` no longer walks the
whole conversation log per frame. Ended sessions are pruned after a five-minute
grace. The `idle` tier maps explicitly to `pollBlurredMs` (an open live editor is
a statement that the user is watching). `lastPublishAt` is stamped when a frame
is *queued*, not when the share takes it, so a slow mount cannot bank a backlog
and then flush it at once. `end`/`leave` drain the in-flight publish chain before
deleting, so a late publish cannot leave a file (or a directory) behind. And a
`board-live` only toasts while the session could still be running
(`boardLiveIsFresh`, `RETENTION.boardsDeadMinutes`) — catching up a log that was
not read since Friday used to toast boards the janitor swept days ago.

## 2026-09-12 — decision: a board's file names are co-presence metadata

**Stream A.** `boards/<sessionId>/<deviceId8>.<seq>` is deliberately readable by
anyone on the share: any team member can list the directory and learn which
devices are in a live session, and roughly how fast each is writing. That is the
price of the property the layout exists for — one `readdir` shows every
participant's latest state, which is what makes a joiner's first read the whole
session and keeps a three-person board at ~7 ops/s each.

Measured in the review round (three real clients over one folder, real
timers, `ShareIo`'s own counter, 20 s windows scaled to the minute), per
participant: **actively drawing** (a scene change every 300 ms plus pointer
moves 4×/s) ≈ 294 ops/min ≈ 4.9 ops/s (publish 21, delete 20, readdir 19,
read 38 per 20 s); **idle with the editor open** ≈ 78 ops/min ≈ 1.3 ops/s
(almost all the 1 s `readdir`); ≈ 5.9 ops/s drawing on a share with 250 ms
write latency; **zero once the editor is closed**. The plan's "≈ 7 ops/s"
holds as an upper bound. Bytes are not bounded the same way: a frame may be
up to `BOARD.maxFrameBytes` (draft bytes) once a second per writer.

What stays hidden is everything inside: the frames are signed then encrypted
under the *conversation* key, so a team member who is not in the DM or the
private group learns nothing about what is being drawn, what the board is
called, or which conversation it belongs to — the session id is random and the
`board-live` announcement lives in the conversation's own (encrypted) log. The
same is true of the session directory's existence: `boards/` shows that someone
is collaborating, not with whom or about what. Screen-share sessions (1.2) made
the same trade under `screens/`.

If that ever becomes unacceptable, the fix is not to rename the files — a reader
has to know whose slot is whose without decrypting every file in the directory —
it is to give each participant a per-session opaque token derived from the
conversation key. That costs a derivation per participant per session and buys
nothing for the DM and private-group cases, where the conversation membership
already bounds who can see the directory at all.

## 2026-09-12 — decision: `BOARD.maxFrameBytes` is a budget for the draft, not the file

**Stream A** (companion to the entry above on how the budget is measured). Worth
stating plainly, because the name suggests otherwise: `maxFrameBytes` bounds
`JSON.stringify(draft)` plus a 512-byte allowance for the envelope fields the
service adds and the signature around them. The file that lands on the share is
*larger* than that — the signed record is JSON-wrapped and base64-carrying, then
the SFC1 envelope adds its header, kid, salt, nonce and tag, and AES-GCM
ciphertext is the size of its plaintext. A 2 MiB budget is therefore roughly a
2.7-3 MiB file at the worst end, per participant per frame, and the share sees at
most one of those per `BOARD.writeMinMs`.

The alternative — measuring the finished ciphertext — means signing and
encrypting a scene only to throw it away, once per rejected write, on the hot
path of a whiteboard. The budget exists to stop a runaway scene, and it does that
just as well one layer up. `BOARD.maxElements` (5000) is the other half of the
same bound: bytes catch a scene with one enormous element, the element cap
catches one with a hundred thousand tiny ones.
