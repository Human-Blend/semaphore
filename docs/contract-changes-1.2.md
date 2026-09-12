# Contract changes during 1.2 implementation

Deviations from the contract described in §1 of the approved 1.2 plan. Each
entry says what moved, why, and what a reviewer should check.

---

## 2026-09-10 — `IO_BUDGET.idleOpsPerMin` 12 → 16, `blurredOpsPerMin` 42 → 48

**Stream C (share I/O budget).** The two smaller budgets were set before
anything could measure the client. Once `poller.test.ts` could run a real
poller, beacon writer, drops inbox and rtc listener against a counting share for
ten simulated minutes per tier, both turned out to sit *below* the arithmetic
floor of the cadences the same contract fixes.

Per-client steady state, team of 5 (so 4 peers), nobody chatting, one channel +
four DMs + two team logs — measured, and reproduced by the arithmetic. Re-run
after the review fixes of 2026-09-11 (first-tick sweep, background default
cadence, focus never dropping to the idle tier):

| source | focused | blurred | idle |
|---|---|---|---|
| `beacon/` listing, one per tick (`POLL.focusedMs`/`backgroundMs`/`idleMs`) | 60 | 20 | 4 |
| reading 4 peers' beacons, one per heartbeat they publish | 12 | 12 | 5.4 |
| this device's own beacon: publish + delete of the previous file | 5.4–5.8 | 5.4–5.8 | 2.4–2.6 |
| blanket catch-up sweep, 8 ops (`POLL.sweep*Ms`) | 8 | 2.4 | 0.8 |
| `drops/<self>` inbox scan (`POLL.dropsInbox*Ms`) | 2 | 2 | 0.2 |
| share-clock calibration stat | 0.2 | 0.2 | 0.2 |
| **total** | **87.6–88.0** | **42.0–42.4** | **13.0–13.2** |

(The own-beacon row is a range because `BEACON.heartbeatJitterMs` moves how many
heartbeats land inside a ten-minute window; the totals move with it.)

The idle floor is the problem: `POLL.idleMs` alone is 4 ops/min, four peers on
`BEACON.idleHeartbeatMs` are 5.33, and this device's own beacon at the same
cadence is 2.67 — **12.0/min before a single sweep, inbox scan or calibration**,
which is exactly the number the budget named. `blurredOpsPerMin: 42` was in the
same position: its own floor is 20 + 12 + 5.4 = **37.4/min**, and the sweep,
inbox scan and calibration the contract asks for in the same paragraph take the
total to the **42.0–42.4** in the table — i.e. the old budget of 42 could not be
met without deleting behaviour.

Nothing was relaxed to get here — the numbers above are *after* the reductions
in this stream (idle tier, per-tier sweep cadence, fast sweep, calibrate-on-a-
timer, drops/rtc idle-out, and a heartbeat-jitter fix).

**Headroom, and what the numbers do not include.** At the modelled team of five
the measurement sits about 8% (focused), 12% (blurred) and 18% (idle) under its
budget — taking the worst run of each: 88.0/96, 42.4/48, 13.2/16. That is enough
for a channel or a conversation more, and not much else: the same harness with
**six peers (a team of seven) measures focused 95.6, blurred 49.2, idle 15.9 —
blurred is over `blurredOpsPerMin`, and the other two are inside by a
whisker**. Anyone raising the modelled team size has to re-derive
the budgets, not just re-run the assertion.

Both the harness and the Settings "Share traffic" readout count *metadata*
traffic — the beacon loop, event publishes, blanket sweeps, the drops inbox —
because that is what the tiers control:

- **Blob and beam bodies are excluded**, and this is why the Settings line says
  "excluding file transfers". `BlobService`/`DropService` stream through
  `node:fs` (`createReadStream`/`createWriteStream` on `ShareIo.abs()`), so a
  100 MB transfer is one counted `stat` and then nothing — it can saturate the
  link without moving either number.
- The harness also leaves out `UpdateService` (one `apps/version.json` stat per
  `POLL.updateMs`, plus the peer-version re-checks) and the janitor (one run a
  day, claimed by one device). Both *do* go through `ShareIo`, so the Settings
  readout includes them; they are out of the budget because they are not per-tier
  cadences.
- Azure DevOps PR polling is not share I/O at all — it is `net.fetch` against
  the ADO REST API — so it appears in neither.

`focusedOpsPerMin` is unchanged: measured 87.6–88.0 against 96.

The measurement is printed on every run (`npm test`) straight to stdout by
`poller.test.ts`'s "share I/O budget" block, because vitest's reporter shows
neither `console.log` nor the names of passing tests.

Reviewer check: the budget is an assertion target and a Settings readout, not
behaviour — no protocol constant moved with it.

---

## 2026-09-10 — `GroupInviteData.key1` is sent on post-rotation invites too (comment only)

**Stream A1 (private groups).** The contract's comment said `key1` rides "only
on rekeys". The plan's own §2 text is wider — "one `group-invite` (current
epoch, includes `key1` when epoch > 1) per newcomer" — and it has to be: the
group's directory token is `HMAC(key1, 'grp-dirtoken')`, so somebody invited
after a rotation cannot even find the log without it. The implementation sends
`key1` whenever the invite or rekey carries an epoch above 1, and the comment in
`types.ts` now says so. **No type changed** — `key1` was and stays optional, and
a 1.2 reader that gets an epoch > 1 message without it ignores the message.

Reviewer check: `GroupService.sendInvite` (one branch, `state.epoch > 1`) and
`acceptKeys`, which refuses any epoch > 1 payload whose `key1` is missing or
whose derived token does not match the group it claims to be.

## 2026-09-10 — added: a removed member's writes under the retired key are ignored

**Stream A1 (private groups).** Not in the plan, and not a contract change —
main-side read behaviour only. Rotating on removal stops the removed device
*reading* the group, but it keeps its old epoch key, and every remaining member
also keeps that key to read history — so without a rule, a removed device could
keep *writing* into the group and everyone would still decrypt it.

`GroupService.staleWrite()` refuses a record when all three hold: it was written
under an epoch below the group's current one, its author is not in the folded
membership, and its event id is later than the point that epoch was retired.
That point comes from the `group-member-removed` event when the reader can read
it, and otherwise from the invite/rekey that told this device it was on the new
epoch (`GroupState.rotations`). History written before the rotation still opens,
including the removed member's own messages.

Reviewer check: `staleWriteCut` in `services/groups.ts` (it was `staleWrite`, a
boolean, until the review — see the 2026-09-11 entry below), its call site at the
end of the decrypt path in `transport/events.ts`, and the integration test
"ignores a removed member still writing under the retired key".

**Corrected 2026-09-11:** this paragraph used to say the call site sits "after
the signature check, so the author is the verified one". It did not:
`ingestFile` computed `verified` and inserted the record either way (a channel
or DM shows an unverified record with a warning chip), so the author handed to
`staleWrite` was the *claimed* `signed.by`. It is now true — a record in a
`grp:` conversation that does not verify is refused outright, before any of
this runs.

---

## 2026-09-11 — added: `EventType` += `'grp'` (a type, not a reshape)

**Stream P (protocol review fixes).** The private-group notices that travel in a
DM log — `group-invite`, `group-rekey`, and the new `group-removed` — were `sys`
events. A shipped 1.1.2 client renders a DM's sys rows through a `sysLine()`
with **no default branch**, so a kind it has never heard of falls off the end of
the switch, returns `undefined`, and draws a blank row in the middle of that
person's DM. Nothing in 1.1 can be fixed now.

So they moved to their own event type, exactly the way `cal`/`prs` did in 1.1:
a `.grp.e1` filename does not match 1.1's `EVENT_RE`, so the file is skipped
without a trace. Nothing was reshaped:

- `EventType` += `'grp'`; `EVENT_RE` in `ids.ts` accepts it.
- new `GrpPayload { t, conv (the DM), kind, data }` and `GroupRemovedData`,
  added to `EventPayload`. `GroupInviteData` is unchanged.
- `SysPayload['kind']` keeps `group-invite`/`group-rekey` and gains
  `group-removed`: `merge.ts` folds a `grp` event into the same `sys` row list
  under the same kind strings, so `sysLine` and the conversation-vanished toast
  keep working unchanged.
- `sysLine()` now has a `default` branch (a neutral line), so this class of bug
  cannot repeat when 1.3 adds a kind. Pinned by `renderer/src/chat/sysLine.test.ts`.
- `DmBeaconSection` += `grpHeads?: string[]` (ring of 4). `noteOwnEvent` must
  **not** put a `.grp.e1` name in `heads`: the DM peer may be a 1.1 client, it
  *can* open that section (it is their DM), and a filename it cannot parse costs
  it nothing by itself — `ingestHeads` skips a name it cannot parse before the
  gap check, in 1.1 exactly as in 1.2, so it never reads as a missing head. The
  real cost is the ring: `heads` holds a fixed number of names per conversation,
  and a burst of invites/rekeys would evict the `msg` filenames a 1.1 reader
  actually ingests from it, costing it a full `catchUp` day scan to find real
  messages instead of reading them off the beacon. A second field is free — an
  unknown field costs a 1.1 reader nothing at all — and gives group notices
  their own budget instead of spending the DM's. 1.2 readers ingest `grpHeads`
  in `processObservation`. **Corrected 2026-09-12:** this entry originally gave
  the reason as the unparsed name itself costing a `catchUp`; 1.3's review round
  found the same mis-statement repeated for `heads2` and traced it back to here
  — see `docs/contract-changes-1.3.md`.

Reviewer check: `redactEventForRenderer` in `shared/prs.ts` blanks `key`/`key1`
on a `grp` payload (the renderer only ever needs the name) — this was the other
half of the finding: the raw group key reached renderer memory on both the
`chat:events` and `push` paths.

---

## 2026-09-11 — a removed member is finally told (`group-removed`)

**Stream P.** `removeMember` writes the removal under the *new* epoch key on
purpose, so the removed device cannot read it; until now that meant the group
simply went quiet on that device forever, which CLAUDE.md listed as a known
deferred item. The owner now also publishes a `grp` `group-removed` notice
(`{ groupId, epoch, name }` — no key material) into the owner↔removed-member DM.
On receipt, when the author is both the group's owner **and** the peer on that
DM, the device drops the group locally exactly as `leave()` does, minus the
publish. Best effort: if that write fails, the device is where 1.1 left it.

## 2026-09-11 — other protocol-review fixes worth a reviewer's eye

**Stream P.** No contract members moved for any of these.

- **Only the owner's invite replaces a group snapshot.** A member's "Add people"
  invite carries whatever membership *their* client folded; taking it as
  `base` re-admitted anyone the owner had removed since. It is key material now,
  nothing else.
- **Adopting a group requires `data.owner === author`.** Nothing on the share
  proves who owns a group, so the only claim worth anything is a device's claim
  about itself; the alternative was letting any teammate plant a group
  attributed to someone else.
- **Membership is therefore owner-managed end to end.** Since a newcomer only
  ever adopts an invite signed by the owner, a member's "Add people" would send
  an invite the other side refuses — a feature that silently does nothing. So
  `GroupService.addMembers` now throws `not-owner` for a non-owner (the same
  string and the same shape as `removeMember`/`remove`), **and** `foldGroupLog`
  ignores a `group-members-added` that is not signed by the owner, so a modified
  client cannot pad the member list with people who will never hold a key.
  Roles, final: **owner** = rename / add / remove / delete; **member** = rename
  / leave. `bridge.ts`'s `groups.addMembers` comment says "Owner only" and the
  renderer hides the menu item for members. Pinned by the integration test "lets
  only the owner add people, in the command and in the fold" and by
  `groupFold.test.ts` "applies an add only from the owner".
- **`staleWrite` → `staleWriteCut`.** The old check compared the *filename stem*
  against the rotation point; the stem is chosen by whoever writes the file, so
  a removed device could back-date one and walk straight through. The provider
  now returns the cut and `ingestFile` compares the file's own mtime (one
  `statMaybe`, only on the retired-epoch path).
- **Unverified records never enter a `grp:` log.** Channels and DMs keep the
  unverified chip; a group cannot afford it, because every rule it has is a
  statement about the author.
- **Beacon `grpSealed` sections are only read from current members.** A removed
  device keeps every key it was given and goes on sealing a section; holding a
  key is not membership.
- **Parking is bounded**: 500 files per conversation, and an epoch more than 8
  above the newest key we hold is refused rather than parked. A parked head is
  no longer treated as a gap, which used to cost a full day-directory walk of
  the group on every peer bump while a rekey was in flight.
- **The janitor needs both clocks.** A deleted conversation's directory is
  removed only when the folded `deletedAt` *and* the directory's own mtime are
  past `RETENTION.deletedConvGraceDays`. `deletedAt` comes from a filename its
  writer chose; the grace exists so an offline client can still read the
  tombstone.
- **The home channel cannot be deleted on the read side either**
  (`foldChannelSys` when `meta.fixed`, and `ChatService.foldSys` for the
  fold-computed home channel of a pre-1.2 team).
- **`create()` reports partial failure.** Every invite is attempted; if some
  fail the group still exists and is already pushed, and the caller gets
  `GroupPartialError` ("group created; N invites failed — use Add people to
  retry"). Same shape for a failed rekey inside `removeMember`.

### 1.1-compat facts a reviewer should not have to rediscover

- **`leave()` does not rotate.** A member who leaves keeps a working copy of the
  current epoch key and can decrypt anything written under it if they keep the
  folder. Only a removal by the owner rotates. If a departure needs to cut
  someone off, the owner removes them.
- **A 1.1 client keeps posting into a channel a 1.2 client deleted.** It has no
  fold for `channel-deleted`, so the channel stays in its sidebar. Its writes
  are invisible to every 1.2 client (which closes the conversation for reading
  and writing alike), and the directory is removed once the grace passes.
- **A 1.1 janitor winner sweeps neither `groups/` nor deleted-conv directories**
  — `DIR.groups` is not in its `SWEEP_EVENT_ROOTS` and it has no deleted-conv
  step at all. Nothing is lost: the next cycle a 1.2 client wins, and both
  sweeps are idempotent.

---

## 2026-09-11 — the idle tier never applies to a focused window

**Stream C (share I/O budget), review fix.** §2 C of the plan derives `idle`
from "system idle ≥ `idleAfterMs`, **or** window hidden and blurred for that
long". Taken literally — and it was implemented literally — a window sitting in
front of someone reading a long thread or watching a screen share dropped to
15 s ticks after three minutes without a keystroke: typing indicators never
rendered, and messages arrived in batches.

`IoTierManager.derive()` now floors a focused window at `blurred`
(`POLL.backgroundMs`), and `idle` requires `!focused`. A focused window with no
input for `POLL.idleAfterMs` therefore reads `blurred`, not `idle` — three quiet
minutes still buy the cheaper cadence, they just never buy the invisible one.
`presence.idleSec` is unchanged and still travels truthfully in every tier, so
peers keep flipping this person to "away" after `PRESENCE.awayIdleSec` exactly
as before. No constant moved.

Reviewer check: `derive()` in `services/ioTier.ts` and the two cases in
`ioTier.test.ts` ("slows a focused window that nobody is typing into, but never
hides it" and "only the unfocused reach the idle tier").

## 2026-09-11 — presence freshness comes from the beacon's stamp

**Stream C, review fix.** `Poller.presenceViews()` derived online/away/offline
from `Date.now() - observedAtMono` — when *this reader* got round to reading the
file. That made the verdict depend on our own tick rate (an idle reader notices
a beacon up to `POLL.idleMs` late, and `BEACON.idleHeartbeatMs` + jitter already
leaves only 2 s of slack inside `PRESENCE.onlineWithinMs`), and it let a beacon
written hours ago read as "online" for a full minute after a cold start or a
resume from a locked screen.

It now uses the stamp the beacon carries — `shareNow - min(content.hlc,
shareNow)`, the same value `lastSeenMs` already reported. Same thresholds, same
states; only the clock changed. `PresenceView.app` is now also gated on the
signature (`obs.verified`), matching the `onPeerVersion` gate one screen above
it: an unsigned beacon can no longer put a version number on a person's row.

Reviewer check: the `age` line in `presenceViews()` and the "presence from a
beacon" block in `poller.test.ts`.

## 2026-09-11 — the peer update banner is a claim, and says so

**Stream C, review fix.** The peer variant of the update banner is raised by a
teammate's beacon, not by anything signed with the release key, so it no longer
borrows the manifest banner's wording ("… is available"). It reads
"<name> says they're on Chat <version> — no signed build in the apps folder
yet.", and the name is clamped to 40 characters (it is untrusted text off the
share sitting in a sentence).

"Remind me later" is also keyed per source now (`update-later:<source>:<version>`
in `localStorage`, was `update-later:<version>`): dismissing the rumour used to
silence the real, signed banner for that same version permanently — the one
banner that can actually copy the zip. A manifest banner additionally clears any
peer dismissal for its version. The rules live in
`renderer/src/app/updateBannerState.ts` so the node-environment suite can pin
them (`updateBannerState.test.ts`).
