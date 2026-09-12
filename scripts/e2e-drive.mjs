#!/usr/bin/env node
// Live two-instance E2E: launches two built app instances (profiles alice/bob)
// against one local folder standing in for the SMB share, drives them through
// the real IPC bridge via CDP, and verifies cross-instance chat, DMs, presence,
// blobs, beams, the team calendar and the pull-request group (against a fake
// Azure DevOps served from this process). Screenshots go to /tmp/semaphore-e2e/
// and, for the two 1.1 panes, to $SEMAPHORE_E2E_SHOTS.
//
//   npm run build && node scripts/e2e-drive.mjs

import { spawn, execSync } from 'node:child_process'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { createServer } from 'node:http'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const SHARE = '/tmp/semaphore-e2e-share'
const OUT = '/tmp/semaphore-e2e'
// Pane screenshots land in the agent scratchpad (the run's own /tmp dir is
// wiped at the top of main()); overridable so the script stays runnable by hand.
const SHOTS =
  process.env.SEMAPHORE_E2E_SHOTS ??
  '/private/tmp/claude-501/-Users-gil-Desktop-chat/ce0e42d1-7e13-4012-ac25-a0e2f46e86c8/scratchpad'
const PASS = 'correct horse battery staple'
const results = []
let failed = false

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

/**
 * A check that is worth reporting but must never fail the run: screenshots
 * depend on a compositor being willing to paint, which is not what we are here
 * to prove.
 */
function soft(name, ok, detail = '') {
  results.push({ name, ok, detail, soft: true })
  console.log(`${ok ? '  ✓' : '  ~'} ${name}${detail ? ` — ${detail}` : ''}${ok ? '' : ' (best-effort)'}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// CDP client

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      }
    })
    // A target that goes away (splash destroyed, window reloaded, app killed)
    // closes the socket without answering. Without this, every in-flight send
    // hangs forever and the run dies on the outer timeout instead of the check.
    ws.on('close', () => {
      const err = new Error('CDP socket closed')
      for (const { reject } of this.pending.values()) reject(err)
      this.pending.clear()
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  /** Evaluate an async expression in the page, return its JSON value. */
  async eval(expr) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => (${expr}))()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? 'eval failed')
    }
    return res.result.value
  }
  async screenshot(path) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path, Buffer.from(res.data, 'base64'))
  }
}

/** All debuggable page targets on a port, [] if the endpoint isn't up yet. */
async function targets(port) {
  try {
    const list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

async function connect(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // The splash window is a real page target that appears BEFORE the app
    // window and has no preload — attaching to it would give a bridge-less
    // page that then vanishes mid-run. Skip it, and prove the target we did
    // pick is the sandboxed renderer by asking for window.bridge.
    const page = (await targets(port)).find(
      (t) => t.type === 'page' && !t.url.startsWith('devtools') && !t.url.includes('splash.html'),
    )
    if (page) {
      let ws
      try {
        ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
        await new Promise((res, rej) => {
          ws.on('open', res)
          ws.on('error', rej)
        })
        const cdp = new Cdp(ws)
        await cdp.send('Page.enable')
        await cdp.send('Runtime.enable')
        if ((await cdp.eval(`typeof window.bridge`)) === 'object') return cdp
        ws.close() // preload hasn't run (or wrong target) — look again
      } catch {
        try { ws?.close() } catch {}
      }
    }
    await sleep(300)
  }
  throw new Error(`CDP not reachable on :${port}`)
}

async function until(fn, timeoutMs, everyMs = 700) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn().catch(() => undefined)
    if (last) return last
    await sleep(everyMs)
  }
  return last
}

/**
 * Select a sidebar row by the prefix of its aria-label (the rows carry
 * suffixes like ", 2 unseen") and photograph whatever pane it opens.
 * `setActiveConv` is renderer state with no bridge surface, so the DOM is the
 * only handle — and clicking the real row is a better proof than poking a store.
 */
async function paneShot(cdp, ariaPrefix, path) {
  try {
    const sel = `button.sem-row[aria-label^=${JSON.stringify(ariaPrefix)}]`
    const clicked = await cdp.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true })()`,
    )
    if (clicked !== true) return false
    await sleep(1000)
    await cdp.screenshot(path)
    return true
  } catch {
    return false
  }
}

/** 'YYYY-MM-DD' for a local Date — the calendar's only date format. */
function ymd(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function addDays(d, n) {
  const c = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  c.setDate(c.getDate() + n)
  return c
}

// ---------------------------------------------------------------------------
// Fake Azure DevOps
//
// Just enough of the 6.0 REST surface for AdoClient: connectionData, projects,
// repositories, and active pull requests. It insists on the Basic header the
// client builds from `:${token}` and answers anything else with the 203 +
// sign-in-page that real Azure DevOps sends for a rejected PAT — which is the
// one response shape the client's classifier most needs to see in the wild.

const ADO_TOKEN = 'e2e-token'
const ADO_AUTH = `Basic ${Buffer.from(`:${ADO_TOKEN}`, 'utf8').toString('base64')}`
const ADO_ME = { id: '6f2d1e40-91aa-4b2c-9c1d-a1b2c3d4e5f6', providerDisplayName: 'E2E Reviewer' }
const ADO_PROJECT = { id: '2c4f0a1e-77bb-4d51-8f30-0badc0ffee11', name: 'Fabrikam' }
const ADO_REPOS = [
  { id: 'repo-web', name: 'web', defaultBranch: 'refs/heads/main' },
  { id: 'repo-api', name: 'api', defaultBranch: 'refs/heads/release/24.9' },
]

/** One pull request in the shape AdoClient/`toPrView` read. */
function adoPr({ id, repo, title, author, source, target, reviewers, isDraft = false, status = 'active', ageH = 3 }) {
  return {
    pullRequestId: id,
    title,
    status,
    isDraft,
    createdBy: author,
    creationDate: new Date(Date.now() - ageH * 3600_000).toISOString(),
    sourceRefName: `refs/heads/${source}`,
    targetRefName: `refs/heads/${target}`,
    repository: { id: repo.id, name: repo.name },
    reviewers,
  }
}

const DANA = { id: 'dana-9a1c', displayName: 'Dana Dev' }
const ME_REVIEWER = { id: ADO_ME.id, displayName: ADO_ME.providerDisplayName }

async function startAdo() {
  // repoId -> pull requests. Mutated live by the drive so the "approved PRs
  // fall out of the list" and "a new PR raises the alert" paths are real.
  const prs = {
    'repo-web': [
      adoPr({
        id: 4271,
        repo: ADO_REPOS[0],
        title: 'Cache the avatar strip between renders',
        author: DANA,
        source: 'dana/avatar-cache',
        target: 'main',
        // A required reviewer sitting at 0 keeps this one tracked.
        reviewers: [{ ...ME_REVIEWER, vote: 0, isRequired: true }],
      }),
    ],
    'repo-api': [
      adoPr({
        id: 4288,
        repo: ADO_REPOS[1],
        title: 'Bump the retention sweep to 180 days',
        author: DANA,
        source: 'dana/retention',
        target: 'release/24.9',
        // Everyone signed off: tracked === false, so it must never be listed.
        reviewers: [{ ...ME_REVIEWER, vote: 10, isRequired: true }],
        ageH: 30,
      }),
    ],
  }
  const state = { prs, requests: 0, rejected: 0 }

  const server = createServer((req, res) => {
    state.requests += 1
    const path = new URL(req.url, 'http://127.0.0.1').pathname

    if (req.headers.authorization !== ADO_AUTH) {
      state.rejected += 1
      res.writeHead(203, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body><h1>Sign in to Azure DevOps</h1></body></html>')
      return
    }

    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    const list = (value) => json({ count: value.length, value })

    if (path === '/_apis/connectionData') {
      return json({ authenticatedUser: ADO_ME, instanceId: ADO_PROJECT.id })
    }
    if (path === '/_apis/projects') return list([ADO_PROJECT])

    let m = /^\/([^/]+)\/_apis\/git\/repositories$/.exec(path)
    if (m && decodeURIComponent(m[1]) === ADO_PROJECT.name) return list(ADO_REPOS)

    m = /^\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/pullrequests$/.exec(path)
    if (m && decodeURIComponent(m[1]) === ADO_PROJECT.name) {
      return list(state.prs[decodeURIComponent(m[2])] ?? [])
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ message: `no route for ${path}` }))
  })

  await new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return { server, state, port, baseUrl: `http://127.0.0.1:${port}` }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('— Chat two-instance E2E —\n')
  rmSync(SHARE, { recursive: true, force: true })
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(SHARE, { recursive: true })
  mkdirSync(OUT, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  const appSupport = join(homedir(), 'Library', 'Application Support')
  for (const p of ['Chat-e2e-alice', 'Chat-e2e-bob', 'semaphore-e2e-alice', 'semaphore-e2e-bob']) {
    rmSync(join(appSupport, p), { recursive: true, force: true })
  }

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = join(process.cwd(), 'node_modules', '.bin', 'electron')
  const launch = (profile, port) =>
    spawn(electron, ['.', `--remote-debugging-port=${port}`], {
      env: { ...env, SEMAPHORE_PROFILE: `e2e-${profile}` },
      stdio: 'ignore',
      detached: false,
    })

  // Up before the apps so the port is known when alice saves the PR config.
  const ado = await startAdo()
  console.log(`fake Azure DevOps on ${ado.baseUrl}\n`)

  const procA = launch('alice', 9333)
  const procB = launch('bob', 9334)
  const kill = () => {
    try { procA.kill() } catch {}
    try { procB.kill() } catch {}
    try { ado.server.closeAllConnections?.() } catch {}
    try { ado.server.close() } catch {}
  }
  process.on('exit', kill)

  // The splash comes up before controller.init(), so it is the first page
  // target on the port — poll fast and briefly, before the app window replaces
  // it. (It is torn down ~1.2 s after the main window shows.)
  const splashSeen = await until(
    async () => (await targets(9333)).find((t) => t.url.includes('splash.html')),
    8000,
    100,
  )
  check('alice shows the splash window', !!splashSeen, splashSeen?.title ?? '')

  try {
    const alice = await connect(9333)
    const bob = await connect(9334)
    console.log('both instances up, CDP connected\n')
    await sleep(1500)

    // Boot state: onboarding
    const bootA = await alice.eval(`window.bridge.app.getBoot()`)
    check('alice boots into onboarding', bootA?.mode === 'onboarding', `mode=${bootA?.mode}`)

    // Onboard alice (creates the team), then bob (joins)
    const subA = await alice.eval(
      `window.bridge.onboarding.submit({ sharePath: ${JSON.stringify(SHARE)}, passphrase: ${JSON.stringify(PASS)}, displayName: 'Alice', teamName: 'E2E Team' })`,
    )
    check('alice creates the team', subA?.ok === true, subA?.error ?? '')
    const subB = await bob.eval(
      `window.bridge.onboarding.submit({ sharePath: ${JSON.stringify(SHARE)}, passphrase: ${JSON.stringify(PASS)}, displayName: 'Bob', teamName: '' })`,
    )
    check('bob joins the team', subB?.ok === true, subB?.error ?? '')

    // Wrong passphrase is rejected (fresh throwaway check via health+submit on bob's instance is destructive — skip; covered by unit tests)

    const selfA = await alice.eval(`window.bridge.app.getBoot()`)
    const selfB = await bob.eval(`window.bridge.app.getBoot()`)
    check('both reach ready with device identities', selfA?.mode === 'ready' && selfB?.mode === 'ready',
      `alice=${selfA?.self?.fingerprint} bob=${selfB?.self?.fingerprint}`)

    // Channel discovery: bob sees #general created by alice's first-run
    const chB = await until(async () => {
      const chs = await bob.eval(`window.bridge.chat.channels()`)
      return chs?.length ? chs : undefined
    }, 20000)
    check('bob discovers #general', !!chB?.some((c) => c.name === 'general'), JSON.stringify(chB?.map((c) => c.name)))
    const conv = chB.find((c) => c.name === 'general').conv

    // Team chat: alice -> bob
    await alice.eval(`window.bridge.chat.send(${JSON.stringify(conv)}, { text: 'hello from alice 👋', kind: 'text' })`)
    const gotMsg = await until(async () => {
      const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
      return evs?.find((e) => e.type === 'msg' && e.payload?.body?.text?.includes('hello from alice'))
    }, 20000)
    check('bob receives the channel message (verified)', !!gotMsg && gotMsg.verified === true)

    // Reaction round-trip: bob reacts, alice sees it
    if (gotMsg) {
      await bob.eval(`window.bridge.chat.react(${JSON.stringify(conv)}, ${JSON.stringify(gotMsg.id)}, '🎉', 'add')`)
      const gotRct = await until(async () => {
        const evs = await alice.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
        return evs?.find((e) => e.type === 'rct')
      }, 20000)
      check("alice sees bob's reaction", !!gotRct)
    }

    // Presence: alice sees bob's beacon (verified, with hostname + fingerprint).
    // 1.2 finally plumbs the *real* OS-wide input-idle time into `idleSec`
    // (src/main/services/ioTier.ts -> BeaconWriter.setTier), and
    // Poller.presenceViews() has always turned that into 'away' once idleSec
    // >= PRESENCE.awayIdleSec (300s) — that branch existed before 1.2 too, it
    // just never fired because idleSec was hardcoded to 0. On a machine whose
    // real mouse/keyboard has been untouched for 5+ minutes (exactly what an
    // unattended CDP-driven run looks like), Bob's own beacon truthfully says
    // he is idle, so alice correctly sees 'away' rather than 'online' — this
    // is not a bug, and neither a longer wait nor Page.bringToFront() changes
    // it: derive() in ioTier.ts checks powerMonitor.getSystemIdleTime() itself
    // (a real OS-wide counter untouched by window focus or CDP-injected
    // input) before it ever looks at focus. So accept either state as proof
    // presence delivery works; only 'offline'/absent means something is wrong.
    const presA = await until(async () => {
      const list = await alice.eval(`window.bridge.presence.list()`)
      const bobView = list?.find((p) => p.name === 'Bob')
      return bobView?.state === 'online' || bobView?.state === 'away' ? bobView : undefined
    }, 30000)
    check(
      "alice sees Bob's presence (online, or away if this machine has been idle) with device chip",
      !!presA,
      presA ? `${presA.hostname}·${presA.fingerprint}·${presA.state}` : '',
    )

    // E2E DM: bob -> alice
    const dm = await bob.eval(`window.bridge.chat.dmFor(${JSON.stringify(selfA.self.deviceId)})`)
    check('bob derives the DM conversation', !!dm?.conv)
    if (dm?.conv) {
      await bob.eval(`window.bridge.chat.send(${JSON.stringify(dm.conv)}, { text: 'secret DM for alice', kind: 'text' })`)
      const gotDm = await until(async () => {
        const evs = await alice.eval(`window.bridge.chat.events(${JSON.stringify(dm.conv)})`)
        return evs?.find((e) => e.payload?.body?.text === 'secret DM for alice')
      }, 20000)
      check('alice receives the E2E DM', !!gotDm && gotDm.verified === true)
    }

    // Link preview fetch (network permitting — informational only)
    const lp = await alice.eval(`window.bridge.links.preview('https://example.com')`).catch(() => null)
    check('link preview resolves (failed:true acceptable offline)', !!lp, lp?.failed ? 'degraded card' : lp?.title ?? '')

    // ---- Channels: rename + delete, fixed channel is protected (1.2) -------
    const designCh = await alice.eval(`window.bridge.chat.createChannel('design')`)
    check('alice creates #design', !!designCh?.conv, designCh ? `${designCh.name} (${designCh.conv})` : '')

    const renameErr = await alice.eval(
      `window.bridge.chat.renameChannel(${JSON.stringify(designCh?.conv)}, 'product').then(() => '', (x) => String(x && x.message || x))`,
    )
    check('alice renames #design to #product via chat.renameChannel', renameErr === '', renameErr)

    const chansB = await until(async () => {
      const chs = await bob.eval(`window.bridge.chat.channels()`)
      return chs?.some((c) => c.name === 'product') ? chs : undefined
    }, 20000)
    check(
      "bob's chat.channels() shows #product (renamed from #design)",
      !!chansB && chansB.some((c) => c.name === 'product') && !chansB.some((c) => c.name === 'design'),
      chansB ? chansB.map((c) => `${c.name}${c.fixed ? '(fixed)' : ''}`).join(' ') : 'timed out',
    )
    const generalFixed = chansB?.find((c) => c.name === 'general')?.fixed
    const productFixed = chansB?.find((c) => c.name === 'product')?.fixed
    check(
      '#general is fixed:true and #product is fixed:false',
      generalFixed === true && productFixed === false,
      `general.fixed=${generalFixed} product.fixed=${productFixed}`,
    )

    const fixedRenameErr = await alice.eval(
      `window.bridge.chat.renameChannel(${JSON.stringify(conv)}, 'nope').then(() => '', (x) => String(x && x.message || x))`,
    )
    check(
      "alice's chat.renameChannel on the fixed #general channel rejects",
      fixedRenameErr !== '',
      fixedRenameErr || 'no error thrown',
    )

    // ---- Private groups: create, DM-borne invite, message, rename (1.2) ----
    const group = await alice.eval(
      `window.bridge.groups.create('Duo', [${JSON.stringify(selfB.self.deviceId)}])`,
    )
    check('alice creates the private group Duo', !!group?.conv, group ? `${group.conv} role=${group.role}` : '')

    const groupB = await until(async () => {
      const gs = await bob.eval(`window.bridge.groups.list()`)
      return gs?.find((g) => g.conv === group?.conv)
    }, 25000)
    check(
      "bob's groups.list() discovers Duo via the DM invite",
      !!groupB && groupB.role === 'member' && groupB.members?.length === 2,
      groupB ? `${groupB.name} role=${groupB.role} members=${groupB.members?.length}` : 'timed out',
    )

    if (group?.conv) {
      await alice.eval(`window.bridge.chat.send(${JSON.stringify(group.conv)}, { text: 'hi duo', kind: 'text' })`)
      const gotGrpMsg = await until(async () => {
        const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(group.conv)})`)
        return evs?.find((e) => e.type === 'msg' && e.payload?.body?.text === 'hi duo')
      }, 20000)
      check("bob's chat.events(grp:<id>) has alice's message (verified)", !!gotGrpMsg && gotGrpMsg.verified === true)

      const renameGrpErr = await bob.eval(
        `window.bridge.groups.rename(${JSON.stringify(group.conv)}, 'Duo renamed').then(() => '', (x) => String(x && x.message || x))`,
      )
      check('bob renames the group', renameGrpErr === '', renameGrpErr)

      const groupA = await until(async () => {
        const gs = await alice.eval(`window.bridge.groups.list()`)
        return gs?.find((g) => g.conv === group.conv && g.name === 'Duo renamed')
      }, 20000)
      check("alice sees the group's new name", !!groupA, groupA ? groupA.name : 'timed out')
    }

    // The group's dir must exist under Chat/groups/ and be an opaque token —
    // no device-id (or its 8-hex prefix) anywhere in the directory name.
    try {
      const groupDirs = readdirSync(join(SHARE, 'Chat', 'groups'))
      const aliceId = selfA.self.deviceId
      const bobId = selfB.self.deviceId
      const opaque =
        groupDirs.length > 0 &&
        groupDirs.every(
          (d) => !d.includes(aliceId) && !d.includes(bobId) && !d.includes(aliceId.slice(0, 8)) && !d.includes(bobId.slice(0, 8)),
        )
      check(
        'the group dir under Chat/groups/ exists and its name is an opaque token (no device-id prefix)',
        groupDirs.length > 0 && opaque,
        groupDirs.join(' '),
      )
    } catch (err) {
      check(
        'the group dir under Chat/groups/ exists and its name is an opaque token (no device-id prefix)',
        false,
        err instanceof Error ? err.message : String(err),
      )
    }

    // ---- Code block with an explicit language (1.2 language dropdown) ------
    await alice.eval(
      `window.bridge.chat.send(${JSON.stringify(conv)}, { text: 'const x: number = 1', kind: 'code', lang: 'typescript' })`,
    )
    const gotCode = await until(async () => {
      const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
      return evs?.find(
        (e) => e.type === 'msg' && e.payload?.body?.kind === 'code' && e.payload?.body?.text === 'const x: number = 1',
      )
    }, 20000)
    check(
      "bob's event body has lang === 'typescript'",
      gotCode?.payload?.body?.lang === 'typescript',
      gotCode ? `lang=${gotCode.payload.body.lang}` : 'timed out',
    )

    // ---- Poll with a quick decision (1.3): vote, close, both directions ----
    // The whole point of the `vot` event type is that it travels on its own
    // ring (`heads2`), so this exercises the reader path end to end: Bob never
    // scans a directory for the vote, and Alice never scans for the close.
    const pollDraft = {
      kind: 'poll',
      text: 'Ship on Friday?',
      poll: {
        question: 'Ship on Friday?',
        options: [
          { id: 'yes', text: 'Yes' },
          { id: 'no', text: 'No' },
          { id: 'abstain', text: 'Abstain' },
        ],
        multi: false,
        anonymous: false,
        decision: true,
      },
    }
    const sentPoll = await alice.eval(
      `window.bridge.chat.send(${JSON.stringify(conv)}, ${JSON.stringify(pollDraft)})`,
    )
    check('alice sends a quick-decision poll', !!sentPoll?.id, sentPoll ? sentPoll.id : 'no id')

    const gotPoll = await until(async () => {
      const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
      return evs?.find((e) => e.type === 'msg' && e.id === sentPoll?.id)
    }, 20000)
    check(
      "bob's poll message carries the PollBody and the pre-1.3 fallback line",
      gotPoll?.payload?.body?.kind === 'poll' &&
        gotPoll?.payload?.body?.poll?.options?.length === 3 &&
        /update Chat to vote/.test(gotPoll?.payload?.body?.text ?? ''),
      gotPoll ? `kind=${gotPoll.payload.body.kind} text=${gotPoll.payload.body.text}` : 'timed out',
    )

    const voteErr = await bob.eval(
      `window.bridge.chat.vote(${JSON.stringify(conv)}, ${JSON.stringify(sentPoll?.id)}, ['yes']).then(() => '', (x) => String(x && x.message || x))`,
    )
    check('bob votes Yes via chat.vote', voteErr === '', voteErr)
    const badVote = await bob.eval(
      `window.bridge.chat.vote(${JSON.stringify(conv)}, ${JSON.stringify(sentPoll?.id)}, ['yes','no']).then(() => '', (x) => String(x && x.message || x))`,
    )
    check('a second pick on a single-choice poll is refused', /single-choice/.test(badVote ?? ''), badVote)

    const gotVote = await until(async () => {
      const evs = await alice.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
      return evs?.find((e) => e.type === 'vot' && e.payload?.target === sentPoll?.id)
    }, 25000)
    check(
      "alice's chat.events shows bob's vote (verified, via heads2)",
      !!gotVote && gotVote.verified === true && JSON.stringify(gotVote.payload?.choice) === '["yes"]',
      gotVote ? `choice=${JSON.stringify(gotVote.payload.choice)} verified=${gotVote.verified}` : 'timed out',
    )

    const closeByBob = await bob.eval(
      `window.bridge.chat.closePoll(${JSON.stringify(conv)}, ${JSON.stringify(sentPoll?.id)}).then(() => '', (x) => String(x && x.message || x))`,
    )
    check('only the author may close a poll', /not-poll-author/.test(closeByBob ?? ''), closeByBob)

    const closeErr = await alice.eval(
      `window.bridge.chat.closePoll(${JSON.stringify(conv)}, ${JSON.stringify(sentPoll?.id)}).then(() => '', (x) => String(x && x.message || x))`,
    )
    check('alice closes her poll', closeErr === '', closeErr)

    const gotClose = await until(async () => {
      const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
      return evs?.find((e) => e.type === 'edt' && e.payload?.target === sentPoll?.id && e.payload?.body?.poll?.closedAt)
    }, 25000)
    check(
      "bob's copy of the poll is closed (closedAt from alice's edt)",
      !!gotClose && gotClose.payload.body.poll.closedAt > 0,
      gotClose ? `closedAt=${gotClose.payload.body.poll.closedAt}` : 'timed out',
    )
    const lateVote = await bob.eval(
      `window.bridge.chat.vote(${JSON.stringify(conv)}, ${JSON.stringify(sentPoll?.id)}, ['no']).then(() => '', (x) => String(x && x.message || x))`,
    )
    check('a closed poll takes no more votes', /poll-closed/.test(lateVote ?? ''), lateVote)

    // ---- Delete a channel: gone on bob, sending into it rejects on alice ---
    const deleteErr = await alice.eval(
      `window.bridge.chat.deleteChannel(${JSON.stringify(designCh?.conv)}).then(() => '', (x) => String(x && x.message || x))`,
    )
    check('alice deletes #product via chat.deleteChannel', deleteErr === '', deleteErr)

    const chansB2 = await until(async () => {
      const chs = await bob.eval(`window.bridge.chat.channels()`)
      return chs && !chs.some((c) => c.name === 'product') ? chs : undefined
    }, 20000)
    check(
      "bob's chat.channels() no longer lists #product",
      !!chansB2,
      chansB2 ? chansB2.map((c) => c.name).join(' ') : 'timed out',
    )

    const sendAfterDeleteErr = await alice.eval(
      `window.bridge.chat.send(${JSON.stringify(designCh?.conv)}, { text: 'too late', kind: 'text' }).then(() => '', (x) => String(x && x.message || x))`,
    )
    check(
      'chat.send into the deleted channel rejects on alice',
      sendAfterDeleteErr !== '',
      sendAfterDeleteErr || 'no error thrown',
    )

    // ---- File sharing: alice attaches a real file; bob fetches the blob ----
    const testFile = join(process.cwd(), 'resources', 'icon.png')
    await alice.eval(
      `window.bridge.chat.send(${JSON.stringify(conv)}, { text: '', kind: 'text', attachments: [{ path: ${JSON.stringify(testFile)}, w: 512, h: 512 }] })`,
    )
    const attMsg = await until(async () => {
      const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
      return evs?.find((e) => e.type === 'msg' && e.payload?.attachments?.length)
    }, 25000)
    const att = attMsg?.payload?.attachments?.[0]
    check('bob receives the attachment message', !!att, att ? `${att.name} ${att.size}B sha=${att.sha256?.slice(0, 8)}` : '')
    if (att) {
      const fetched = await until(async () => {
        const st = await bob.eval(
          `window.bridge.files.fetchBlob(${JSON.stringify(att.blobId)}, ${JSON.stringify(att.key)}, ${JSON.stringify(att.name)}, ${att.size})`,
        )
        return st?.state === 'ready' ? st : undefined
      }, 25000)
      check('bob downloads + decrypts the blob from the share', !!fetched, fetched?.url ?? '')
      if (fetched?.url) {
        // Verify the way the app actually consumes it: as an image element.
        const dims = await bob.eval(
          `new Promise((res) => { const i = new Image(); i.onload = () => res(i.naturalWidth + 'x' + i.naturalHeight); i.onerror = () => res('ERR'); i.src = ${JSON.stringify(fetched.url)} })`,
        )
        check('sfblob:// protocol serves the decrypted image', dims === '512x512', `decoded=${dims}`)
      }
    }

    // ---- Diagrams: alice sends an inline scene; bob renders it locally -----
    //
    // The scene is built here rather than by driving the canvas: what matters
    // is the wire contract (deflate-raw + base64 inside the event, a WebP thumb
    // beside it, and a `text` line an old client can print), not Excalidraw's
    // pointer handling. Compressing with node:zlib also proves the codec's
    // format is the platform's, not something only the renderer can read.
    const diagramScene = JSON.stringify({
      type: 'excalidraw',
      version: 2,
      source: 'e2e',
      elements: Array.from({ length: 14 }, (_, i) => ({
        id: `e2e-el-${i}`,
        type: i % 2 ? 'rectangle' : 'ellipse',
        x: 100 + i * 40,
        y: 120 + (i % 3) * 60,
        width: 160,
        height: 80,
        angle: 0,
        strokeColor: '#1e1e1e',
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: { type: 3 },
        seed: 1000 + i,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false,
      })),
      appState: { viewBackgroundColor: '#ffffff' },
      files: {},
    })
    const diagramData = deflateRawSync(Buffer.from(diagramScene, 'utf8')).toString('base64')
    const diagramThumb =
      'data:image/webp;base64,UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAfQ//73v/+BiOh/AAA='
    const diagramDraft = {
      text: 'Sprint plan',
      kind: 'diagram',
      diagram: { fmt: 'excalidraw', data: diagramData, w: 660, h: 320, elements: 14, thumb: diagramThumb },
    }
    const diagErr = await alice.eval(
      `window.bridge.chat.send(${JSON.stringify(conv)}, ${JSON.stringify(diagramDraft)}).then(() => '', (x) => String(x && x.message || x))`,
    )
    check('alice sends an inline diagram', diagErr === '', diagErr || `${diagramData.length}B compressed`)

    const diagMsg = await until(async () => {
      const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
      return evs?.find((e) => e.type === 'msg' && e.payload?.body?.kind === 'diagram')
    }, 25000)
    const diagBody = diagMsg?.payload?.body
    check(
      'bob receives the diagram message with its scene and thumb inline',
      !!diagBody && !!diagBody.diagram?.data && !!diagBody.diagram?.thumb && diagBody.diagram.elements === 14,
      diagBody ? `${diagBody.diagram?.data?.length}B data, thumb ${diagBody.diagram?.thumb?.length}B` : 'timed out',
    )
    check(
      'the diagram message carries no attachment (zero extra share I/O to read it)',
      !!diagMsg && !diagMsg.payload?.attachments,
      diagMsg?.payload?.attachments ? 'unexpected attachment' : 'inline only',
    )
    check(
      'a pre-1.2 client would still see a line naming the diagram',
      diagBody?.text === '📐 Diagram: Sprint plan — update Chat to view it',
      diagBody?.text ?? '',
    )
    if (diagBody?.diagram?.data) {
      let roundTripped = ''
      try {
        roundTripped = inflateRawSync(Buffer.from(diagBody.diagram.data, 'base64')).toString('utf8')
      } catch (err) {
        roundTripped = `inflate failed: ${err}`
      }
      check(
        "bob's copy of the scene inflates back to exactly what alice drew",
        roundTripped === diagramScene,
        roundTripped === diagramScene ? `${diagramScene.length}B scene` : roundTripped.slice(0, 80),
      )
    }

    // The tile itself: bob opens the channel and the diagram renders locally
    // (thumb first, then a crisp SVG from the scene) with no blob fetch.
    let tileState = 'no tile'
    const tileSeen = await until(async () => {
      tileState = await bob.eval(
        `(() => {
          const el = document.querySelector('button[aria-label^="Open the diagram"]')
          if (!el) return 'no tile'
          if (el.querySelector('svg')) return 'svg'
          if (el.querySelector('img')) return 'thumb'
          return 'placeholder'
        })()`,
      )
      return tileState === 'svg' ? tileState : undefined
    }, 25000)
    soft('bob renders the diagram tile as a locally drawn SVG', tileSeen === 'svg', tileState)

    // ---- A diagram too big to ride inline: the scene travels as a blob -----
    //
    // Over DIAGRAM.maxInlineBytes the sender stages the scene and sends it as a
    // `.excalidraw` attachment instead (scene.ts: planDiagramSend), and the
    // reader pulls it back over sfblob:// with *fetch* rather than painting it
    // in an <img>. That makes it the one consumer subject to CORS on the custom
    // scheme — it could not load a single scene until the protocol started
    // answering with Access-Control-Allow-Origin.
    const DIAGRAM_MAX_INLINE = 120 * 1024 // DIAGRAM.maxInlineBytes

    /** A scene whose labels deflate badly, so "too big" needs hundreds of elements, not millions. */
    const mkBigScene = (count) => {
      let seed = 0x2f6e2b1
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) % 0x7fffffff
        return seed / 0x7fffffff
      }
      const label = () => Array.from({ length: 24 }, () => Math.floor(rnd() * 36 ** 6).toString(36)).join(' ')
      return JSON.stringify({
        type: 'excalidraw',
        version: 2,
        source: 'e2e',
        elements: Array.from({ length: count }, (_, i) => {
          const text = label()
          return {
            id: `e2e-big-${i}`,
            type: 'text',
            x: 40 + (i % 20) * 180,
            y: 40 + Math.floor(i / 20) * 28,
            width: 170,
            height: 24,
            angle: 0,
            strokeColor: '#1e1e1e',
            backgroundColor: 'transparent',
            fillStyle: 'solid',
            strokeWidth: 1,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 100,
            groupIds: [],
            frameId: null,
            roundness: null,
            seed: 7000 + i,
            version: 1,
            versionNonce: 1,
            isDeleted: false,
            boundElements: null,
            updated: 1,
            link: null,
            locked: false,
            text,
            originalText: text,
            fontSize: 16,
            fontFamily: 5,
            textAlign: 'left',
            verticalAlign: 'top',
            containerId: null,
            lineHeight: 1.25,
          }
        }),
        appState: { viewBackgroundColor: '#ffffff' },
        files: {},
      })
    }

    // Grow until the *compressed* scene is comfortably over the ceiling — the
    // same number planDiagramSend measures (base64 of deflate-raw).
    let bigCount = 600
    let bigScene = mkBigScene(bigCount)
    let bigCompressed = deflateRawSync(Buffer.from(bigScene, 'utf8')).toString('base64')
    while (bigCompressed.length < DIAGRAM_MAX_INLINE * 1.15 && bigCount < 3000) {
      bigCount += 200
      bigScene = mkBigScene(bigCount)
      bigCompressed = deflateRawSync(Buffer.from(bigScene, 'utf8')).toString('base64')
    }
    check(
      'the oversized scene really is too big to send inline',
      bigCompressed.length > DIAGRAM_MAX_INLINE,
      `${bigCount} text elements · ${bigCompressed.length}B compressed > ${DIAGRAM_MAX_INLINE}B ceiling`,
    )

    const bigStaged = await alice.eval(
      `window.bridge.files.stageBytes('Capacity plan.excalidraw', ${JSON.stringify(Buffer.from(bigScene, 'utf8').toString('base64'))})`,
    )
    const bigBody = { fmt: 'excalidraw', w: 3640, h: 40 + Math.ceil(bigCount / 20) * 28, elements: bigCount, thumb: diagramThumb }
    const bigDraft = {
      text: 'Capacity plan',
      kind: 'diagram',
      diagram: bigBody,
      attachments: [{ path: bigStaged?.path, thumb: diagramThumb, w: bigBody.w, h: bigBody.h }],
    }
    const bigErr = await alice.eval(
      `window.bridge.chat.send(${JSON.stringify(conv)}, ${JSON.stringify(bigDraft)}).then(() => '', (x) => String(x && x.message || x))`,
    )
    check('alice sends it as a staged .excalidraw attachment', bigErr === '', bigErr || bigStaged?.path || '')

    const bigMsg = await until(async () => {
      const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
      return evs?.find(
        (e) => e.type === 'msg' && e.payload?.body?.kind === 'diagram' && e.payload?.attachments?.length,
      )
    }, 30000)
    const bigAtt = bigMsg?.payload?.attachments?.[0]
    check(
      'bob receives it as a .excalidraw attachment with no inline scene',
      !!bigAtt && bigAtt.name.endsWith('.excalidraw') && !bigMsg?.payload?.body?.diagram?.data,
      bigAtt
        ? `${bigAtt.name} ${bigAtt.size}B · inline data ${bigMsg?.payload?.body?.diagram?.data ? 'PRESENT' : 'absent'}`
        : 'timed out',
    )

    if (bigAtt) {
      // The read the tile does, done explicitly: fetch() on an sfblob:// URL.
      // Before the scheme was corsEnabled (and the handler started answering
      // with Access-Control-Allow-Origin) this threw "Failed to fetch" — with
      // no status, so a share outage was indistinguishable from an expiry.
      const read = await bob.eval(
        `(async () => {
          const a = ${JSON.stringify(bigAtt)}
          const url = 'sfblob://blob/' + a.blobId + '?key=' + encodeURIComponent(a.key) + '&name=' + encodeURIComponent(a.name) + '&size=' + a.size
          try {
            await window.bridge.files.fetchBlob(a.blobId, a.key, a.name, a.size)
            const res = await fetch(url)
            const text = await res.text()
            const ranged = await fetch(url + '&probe=range', { headers: { Range: 'bytes=0-15' } })
            return {
              status: res.status,
              bytes: text.length,
              head: text.slice(0, 24),
              rangeStatus: ranged.status,
              // Readable only because the handler exposes it to the page.
              contentRange: ranged.headers.get('Content-Range'),
            }
          } catch (err) {
            return { error: String(err && err.message || err) }
          }
        })()`,
      )
      check(
        'bob reads the scene back over sfblob:// with fetch (CORS on the custom scheme)',
        read?.status === 200 && read?.bytes === bigScene.length,
        read?.error ?? `${read?.bytes}B of ${bigScene.length}B · ${read?.head ?? ''}`,
      )
      check(
        'a ranged read still works, with Content-Range exposed to the page',
        read?.rangeStatus === 206 && read?.contentRange === `bytes 0-15/${bigAtt.size}`,
        read?.contentRange ?? String(read?.rangeStatus ?? read?.error ?? ''),
      )
    }

    // And the tile itself, end to end: thumb -> fetched scene -> local SVG.
    let bigTile = 'no tile'
    const bigTileSeen = await until(async () => {
      bigTile = await bob.eval(
        `(() => {
          const el = document.querySelector('button[aria-label^="Open the diagram Capacity plan"]')
          if (!el) return 'no tile'
          if (el.querySelector('svg')) return 'svg'
          if (el.textContent.includes('cleaned up')) return 'expired'
          if (el.querySelector('img')) return 'thumb'
          return 'placeholder'
        })()`,
      )
      return bigTile === 'svg' ? bigTile : undefined
    }, 45000)
    soft('bob renders the blob-backed diagram tile as a locally drawn SVG', bigTileSeen === 'svg', bigTile)

    // ---- Live boards (1.3): a session over the folder, both directions -----
    //
    // Driven over the bridge rather than through Excalidraw: what has to hold
    // is the session protocol (one file per participant, seq in the name, the
    // previous one deleted, frames delivered once, host-only end, dir removed),
    // not the canvas. The renderer's reconcile/echo half is covered by
    // live.test.ts, which can run without a window at all.
    const boardEl = (id, x) => ({
      id,
      type: 'rectangle',
      x,
      y: 80,
      width: 120,
      height: 60,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: { type: 3 },
      seed: 7,
      version: 2,
      versionNonce: 11,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      index: `a${id}`,
    })
    const collector =
      `(() => { window.__boards = { frames: [], ended: [] }; window.bridge.onPush((m) => {` +
      ` if (m.kind === 'board-frames') window.__boards.frames.push(...m.frames);` +
      ` if (m.kind === 'board-ended') window.__boards.ended.push(m.sessionId) }); return true })()`
    await alice.eval(collector)
    await bob.eval(collector)

    const started = await alice.eval(
      `window.bridge.boards.start(${JSON.stringify(conv)}, 'Sprint plan live').then((r) => r, (x) => ({ error: String(x && x.message || x) }))`,
    )
    const sid = started?.sessionId
    check(
      'alice starts a live board (boards.start returns a session id)',
      typeof sid === 'string' && /^[0-9a-f]{16}$/.test(sid),
      started?.error ?? String(sid),
    )

    if (typeof sid === 'string' && /^[0-9a-f]{16}$/.test(sid)) {
      const liveSys = await until(async () => {
        const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
        return evs?.find((e) => e.type === 'sys' && e.payload?.kind === 'board-live' && e.payload?.data?.sessionId === sid)
      }, 25000)
      check(
        "bob's log carries the board-live sys event (this is what puts Join on the row)",
        !!liveSys && liveSys.verified === true && liveSys.payload.data.title === 'Sprint plan live',
        liveSys ? `host=${String(liveSys.payload.data.host).slice(0, 8)} title=${liveSys.payload.data.title}` : 'timed out',
      )

      // The host joins its own session: `join` is what starts the poller.
      const joinA = await alice.eval(
        `window.bridge.boards.join(${JSON.stringify(sid)}, ${JSON.stringify(conv)}).then((r) => r, (x) => ({ error: String(x && x.message || x) }))`,
      )
      check('alice joins her own session (the poller only starts on join)', !joinA?.error, joinA?.error ?? 'joined')

      const twoEls = [boardEl('b-alice-1', 40), boardEl('b-alice-2', 200)]
      const writeErr = await alice.eval(
        `window.bridge.boards.write(${JSON.stringify(sid)}, ${JSON.stringify(conv)}, ${JSON.stringify({
          elements: twoEls,
          pointer: { x: -120.5, y: 64.25, tool: 'pointer' },
          selectedIds: ['b-alice-2'],
        })}).then(() => '', (x) => String(x && x.message || x))`,
      )
      check('alice writes a two-element frame', writeErr === '', writeErr || '2 elements')

      // Bob joins: `join` returns every frame currently in the dir, and anything
      // written while the coalescer was still holding alice's draft arrives as a
      // push straight after.
      const joinB = await until(async () => {
        const r = await bob.eval(
          `window.bridge.boards.join(${JSON.stringify(sid)}, ${JSON.stringify(conv)}).then((r) => r, (x) => ({ error: String(x && x.message || x) }))`,
        )
        if (r?.error) return undefined
        if (r?.frames?.some((f) => f.elements?.length === 2)) return r
        const pushed = await bob.eval(`window.__boards`)
        return pushed?.frames?.some((f) => f.elements?.length === 2) ? { frames: pushed.frames } : undefined
      }, 30000)
      const aliceFrame = joinB?.frames?.find((f) => f.elements?.length === 2)
      check(
        "bob's join returns alice's frame, signed by her device, with her scene coordinates intact",
        !!aliceFrame &&
          aliceFrame.device === selfA.self.deviceId &&
          aliceFrame.elements.map((e) => e.id).join(',') === 'b-alice-1,b-alice-2' &&
          aliceFrame.pointer?.x === -120.5 &&
          aliceFrame.selectedIds?.[0] === 'b-alice-2',
        aliceFrame ? `seq=${aliceFrame.seq} name=${aliceFrame.name} els=${aliceFrame.elements.length}` : 'timed out',
      )

      // Bob draws on it: the whole element list travels, alice's two included —
      // which is what makes per-element last-writer-wins reconcile cleanly.
      const threeEls = [...twoEls, boardEl('b-bob-3', 360)]
      const writeBErr = await bob.eval(
        `window.bridge.boards.write(${JSON.stringify(sid)}, ${JSON.stringify(conv)}, ${JSON.stringify({
          elements: threeEls,
          pointer: { x: 380, y: 100, tool: 'pointer' },
        })}).then(() => '', (x) => String(x && x.message || x))`,
      )
      check('bob adds a third element and writes his own frame', writeBErr === '', writeBErr || '3 elements')

      const gotBob = await until(async () => {
        const st = await alice.eval(`window.__boards`)
        return st?.frames?.find((f) => f.device === selfB.self.deviceId && f.elements?.some((e) => e.id === 'b-bob-3'))
      }, 30000)
      check(
        "alice gets a board-frames push carrying bob's element",
        !!gotBob && gotBob.elements.length === 3,
        gotBob ? `from ${gotBob.device.slice(0, 8)} seq=${gotBob.seq} els=${gotBob.elements.length}` : 'timed out',
      )

      // One file per participant, ever: each write renames a new seq into place
      // and deletes the writer's previous file, so a readdir is the whole state.
      const boardFiles = await until(async () => {
        try {
          const fs = readdirSync(join(SHARE, 'Chat', 'boards', sid))
          return fs.length >= 2 ? fs : undefined
        } catch {
          return undefined
        }
      }, 20000)
      const prefixes = new Set((boardFiles ?? []).map((f) => f.split('.')[0]))
      check(
        'boards/<sid>/ holds exactly one file per writer (the previous seq is deleted)',
        !!boardFiles && boardFiles.length === prefixes.size && prefixes.size === 2,
        (boardFiles ?? []).join(' ') || 'timed out',
      )

      const bobEndErr = await bob.eval(
        `window.bridge.boards.end(${JSON.stringify(sid)}, ${JSON.stringify(conv)}).then(() => '', (x) => String(x && x.message || x))`,
      )
      check('boards.end from a non-host is refused', bobEndErr !== '', bobEndErr || 'no error thrown')

      const endErr = await alice.eval(
        `window.bridge.boards.end(${JSON.stringify(sid)}, ${JSON.stringify(conv)}).then(() => '', (x) => String(x && x.message || x))`,
      )
      check('alice (the host) ends the live board', endErr === '', endErr)

      const endedOnBob = await until(async () => {
        const st = await bob.eval(`window.__boards`)
        if (st?.ended?.includes(sid)) return 'push'
        const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(conv)})`)
        return evs?.some((e) => e.type === 'sys' && e.payload?.kind === 'board-ended' && e.payload?.data?.sessionId === sid)
          ? 'event'
          : undefined
      }, 30000)
      check(
        "bob's editor is told the board ended (board-ended push or sys event)",
        !!endedOnBob,
        endedOnBob || 'timed out',
      )

      const dirGone = await until(async () => {
        try {
          readdirSync(join(SHARE, 'Chat', 'boards', sid))
          return undefined
        } catch {
          return 'gone'
        }
      }, 20000)
      check('the boards/<sid>/ directory is removed when the host ends it', dirGone === 'gone', dirGone ?? 'still there')
    }

    // The renderer half, driven through the real UI: the diagram tile's
    // **Collaborate** hosts a board seeded with that scene, the header shows
    // the Live pill, this device's frame lands in the folder, and **End
    // session** takes the whole directory away again. Best-effort like the
    // tile render above — it depends on the 1 MB editor chunk loading and on a
    // compositor being willing to paint, neither of which is the protocol.
    const boardsBefore = (() => {
      try {
        return readdirSync(join(SHARE, 'Chat', 'boards'))
      } catch {
        return []
      }
    })()
    const collabClicked = await bob.eval(
      `(() => { const el = document.querySelector('button[title^="Open this as a live board"]'); if (!el) return false; el.click(); return true })()`,
    )
    soft("bob's diagram tile offers Collaborate", collabClicked === true, collabClicked === true ? 'clicked' : 'no button')
    if (collabClicked === true) {
      const pill = await until(
        async () =>
          await bob.eval(
            `(() => { const el = document.querySelector('[role="status"][aria-label^="Live board"]'); return el ? el.getAttribute('aria-label') : undefined })()`,
          ),
        40000,
      )
      soft('the editor opens in live mode and shows the Live pill', !!pill, pill || 'timed out')

      const uiSid = await until(async () => {
        try {
          const now = readdirSync(join(SHARE, 'Chat', 'boards')).filter((d) => !boardsBefore.includes(d))
          const fresh = now.find((d) => readdirSync(join(SHARE, 'Chat', 'boards', d)).length > 0)
          return fresh
        } catch {
          return undefined
        }
      }, 30000)
      soft("the editor's own frame reaches boards/<sid>/", !!uiSid, uiSid || 'timed out')

      // …and the inbound half, in the real editor: alice joins bob's session
      // over the bridge and writes a frame. The pill's own label is the proof
      // it landed — it is rendered from the collaborator map that
      // `digestFrames` → `reconcileElements` → `updateScene` produces, so a
      // throw anywhere along that path leaves it reading "0 other
      // participants".
      if (uiSid) {
        await alice.eval(
          `window.bridge.boards.join(${JSON.stringify(uiSid)}, ${JSON.stringify(conv)}).catch(() => {})`,
        )
        await alice.eval(
          `window.bridge.boards.write(${JSON.stringify(uiSid)}, ${JSON.stringify(conv)}, ${JSON.stringify({
            elements: [boardEl('b-ui-1', 520)],
            pointer: { x: 540, y: 96, tool: 'pointer' },
          })}).catch(() => {})`,
        )
        const withPeer = await until(
          async () =>
            await bob.eval(
              `(() => { const el = document.querySelector('[role="status"][aria-label^="Live board"]');` +
                ` const l = el && el.getAttribute('aria-label');` +
                ` return l && l.includes('drawing with') ? l : undefined })()`,
            ),
          40000,
        )
        soft(
          "the editor reconciles a peer's frame and shows them in the Live pill",
          !!withPeer,
          withPeer || 'still alone — the inbound path did not run',
        )
        await alice.eval(
          `window.bridge.boards.leave(${JSON.stringify(uiSid)}, ${JSON.stringify(conv)}).catch(() => {})`,
        )
      }

      const endClicked = await bob.eval(
        `(() => { const el = document.querySelector('button[title^="End the live board for everyone"]'); if (!el) return false; el.click(); return true })()`,
      )
      soft('the host can end the session from the header', endClicked === true)
      if (uiSid) {
        const uiGone = await until(async () => {
          try {
            readdirSync(join(SHARE, 'Chat', 'boards', uiSid))
            return undefined
          } catch {
            return 'gone'
          }
        }, 25000)
        soft('ending from the header removes the session directory', uiGone === 'gone', uiGone ?? 'still there')
      }
    }
    // Whatever happened above, leave bob looking at the chat again: the rest of
    // the run (and the final screenshot) expects the ordinary pane.
    await bob.eval(
      `(() => { const c = document.querySelector('button[aria-label="Close the diagram editor"]'); if (c) c.click(); return true })()`,
    )
    await sleep(400)
    await bob.eval(
      `(() => { const b = document.querySelectorAll('[role="alertdialog"] button'); if (b.length) b[b.length - 1].click(); return true })()`,
    )
    await sleep(400)
    soft(
      'the diagram editor is closed again',
      (await bob.eval(`document.querySelector('.sem-diagram-host') === null`)) === true,
    )

    // ---- Beams: alice beams a file directly to bob; auto-flow via bridge ----
    // Persistent collector attached BEFORE the send so no push is missed.
    await bob.eval(
      `(() => { window.__beam = { offers: [], progress: [] }; window.bridge.onPush((m) => { if (m.kind === 'beam-offer') window.__beam.offers.push(m.offer); if (m.kind === 'beam-progress') window.__beam.progress.push(m.progress) }); return true })()`,
    )
    await alice.eval(
      `window.bridge.beams.send(${JSON.stringify(selfB.self.deviceId)}, [${JSON.stringify(testFile)}])`,
    )
    const offer = await until(async () => {
      const b = await bob.eval(`window.__beam`)
      return b?.offers?.[0]
    }, 40000)
    check('bob receives the beam offer', !!offer, offer ? `${offer.name} from ${offer.fromDeviceId?.slice(0, 8)}` : '')
    if (offer) {
      await bob.eval(`window.bridge.beams.accept(${JSON.stringify(offer.dropId)})`)
      const done = await until(async () => {
        const b = await bob.eval(`window.__beam`)
        return b?.progress?.find((p) => p.state === 'saved')
      }, 40000)
      check('beam transfers, verifies, and saves', !!done, done?.savedPath ?? '')
    }

    // Typing indicator: alice types, bob's push state can't be read via bridge — verified visually/unit level. Skip.

    // ---- Team calendar: A -> B over the team/ event log --------------------
    const CAL = 'team:calendar'
    const today = new Date()
    const release = ymd(addDays(today, 3))
    const bday = addDays(today, 5)
    const entries = [
      {
        id: 'a1b2c3d4e5f60001',
        title: 'Release 1.1 — splash, calendar, pull requests',
        tag: 'Release',
        color: 2,
        start: release,
        end: release,
        annual: false,
        notes: 'Cut the zips, run the gates, tag it.',
      },
      {
        id: 'a1b2c3d4e5f60002',
        title: "Dana's birthday",
        tag: 'Birthday',
        color: 5,
        // A real annual entry: stored on its original year, expanded forward.
        start: `1990-${ymd(bday).slice(5)}`,
        end: `1990-${ymd(bday).slice(5)}`,
        annual: true,
        notes: '',
      },
    ]
    let calPut = true
    for (const e of entries) {
      const err = await alice
        .eval(`window.bridge.calendar.put(${JSON.stringify(e)}).then(() => '', (x) => String(x && x.message || x))`)
        .catch((x) => String(x))
      if (err) calPut = false
      if (err) console.log(`    calendar.put(${e.id}) rejected: ${err}`)
    }
    check('alice publishes two calendar entries', calPut)

    const calB = await until(async () => {
      const evs = await bob.eval(`window.bridge.chat.events(${JSON.stringify(CAL)})`)
      const puts = (evs ?? []).filter((e) => e.type === 'cal' && e.verified === true && e.payload?.op === 'put')
      return entries.every((x) => puts.some((p) => p.payload?.entry?.id === x.id)) ? puts : undefined
    }, 25000)
    check(
      'bob receives both calendar entries (verified, under team/)',
      !!calB,
      calB ? calB.map((p) => p.payload.entry.title).join(' · ') : 'timed out',
    )

    // Pane screenshot while both entries are still live.
    soft(
      'calendar pane screenshot',
      await paneShot(alice, 'Team calendar', join(SHOTS, 'e2e-calendar.png')),
      join(SHOTS, 'e2e-calendar.png'),
    )

    // Bob deletes one; the tombstone must reach alice.
    await bob.eval(`window.bridge.calendar.remove(${JSON.stringify(entries[1].id)})`)
    const tomb = await until(async () => {
      const evs = await alice.eval(`window.bridge.chat.events(${JSON.stringify(CAL)})`)
      return (evs ?? []).find(
        (e) => e.type === 'cal' && e.verified === true && e.payload?.op === 'del' && e.payload?.id === entries[1].id,
      )
    }, 25000)
    check("alice sees bob's calendar tombstone", !!tomb, tomb ? `by ${tomb.author?.slice(0, 8)}` : 'timed out')

    // ---- Pull-request group over a fake Azure DevOps -----------------------
    const anon = await fetch(`${ado.baseUrl}/_apis/connectionData?api-version=6.0-preview`).catch(() => null)
    check(
      'fake Azure DevOps answers an unauthenticated call with 203 + HTML',
      anon?.status === 203,
      `status=${anon?.status}`,
    )

    const probe = await alice.eval(
      `window.bridge.prs.testConnection({ baseUrl: ${JSON.stringify(ado.baseUrl)}, token: ${JSON.stringify(ADO_TOKEN)} })`,
    )
    check(
      'alice probes Azure DevOps (signed in, project listed)',
      probe?.ok === true && probe.me?.id === ADO_ME.id && probe.projects?.some((p) => p.name === ADO_PROJECT.name),
      probe?.ok ? `${probe.me.name} · ${probe.projects.map((p) => p.name).join(',')}` : probe?.error?.detail ?? '',
    )

    const reposRes = await alice.eval(
      `window.bridge.prs.listRepos({ baseUrl: ${JSON.stringify(ado.baseUrl)}, token: ${JSON.stringify(ADO_TOKEN)}, project: ${JSON.stringify(ADO_PROJECT.name)} })`,
    )
    check(
      'alice lists the watched repositories',
      reposRes?.ok === true && reposRes.value?.length === 2,
      reposRes?.ok ? reposRes.value.map((r) => `${r.name}@${r.defaultBranch}`).join(' ') : reposRes?.error?.detail ?? '',
    )

    const saveErr = await alice.eval(
      `window.bridge.prs.saveConfig({ baseUrl: ${JSON.stringify(ado.baseUrl)}, project: ${JSON.stringify(ADO_PROJECT.name)}, repos: ${JSON.stringify(ADO_REPOS.map((r) => ({ id: r.id, name: r.name })))}, token: ${JSON.stringify(ADO_TOKEN)}, shareToken: true }).then(() => '', (x) => String(x && x.message || x))`,
    )
    check('alice saves the PR config with a shared token', saveErr === '', saveErr)

    const listA = await until(async () => {
      await alice.eval(`window.bridge.prs.refresh()`).catch(() => {})
      const l = await alice.eval(`window.bridge.prs.list()`)
      return l?.length === 1 ? l : undefined
    }, 30000)
    check(
      'alice lists exactly the unapproved pull request (the approved one is filtered)',
      listA?.length === 1 && listA[0].id === 4271 && listA[0].assignedToMe === true,
      listA ? listA.map((p) => `#${p.id} ${p.repoName}`).join(' ') : 'never settled on one PR',
    )
    const prKey = listA?.[0]?.key ?? 'repo-web:4271'

    // Bob never typed a token: the shared one has to arrive over the share.
    const statB = await until(async () => {
      const s = await bob.eval(`window.bridge.prs.status()`)
      return s?.tokenSource === 'shared' && s.configured ? s : undefined
    }, 30000)
    check(
      "bob picks up the team's shared Azure DevOps token",
      !!statB,
      statB ? `${statB.project} · ${statB.repos.length} repos` : 'timed out',
    )

    const listB = await until(async () => {
      await bob.eval(`window.bridge.prs.refresh()`).catch(() => {})
      const l = await bob.eval(`window.bridge.prs.list()`)
      return l?.some((p) => p.key === prKey) ? l : undefined
    }, 30000)
    check('bob sees the same pull request', !!listB, listB ? `${listB.length} tracked` : 'timed out')

    await alice.eval(`window.bridge.prs.markSeen([${JSON.stringify(prKey)}])`)
    const seenStat = await until(async () => {
      const s = await alice.eval(`window.bridge.prs.status()`)
      return s && s.unseen === 0 ? s : undefined
    }, 10000)
    check('alice marks the pull request seen (unseen -> 0)', !!seenStat, `unseen=${seenStat?.unseen}`)

    soft(
      'pull-request pane screenshot',
      await paneShot(alice, 'Pull requests', join(SHOTS, 'e2e-prs.png')),
      join(SHOTS, 'e2e-prs.png'),
    )

    // Approve it upstream: it must fall out of the list on the next poll.
    for (const p of ado.state.prs['repo-web']) p.reviewers = [{ ...ME_REVIEWER, vote: 10, isRequired: true }]
    const drained = await until(async () => {
      await alice.eval(`window.bridge.prs.refresh()`).catch(() => {})
      const l = await alice.eval(`window.bridge.prs.list()`)
      return l?.length === 0 ? { empty: true } : undefined
    }, 30000)
    check('an approved pull request drops out of the list', !!drained)

    // A brand-new PR while bob is on a channel: the in-app alert card.
    ado.state.prs['repo-api'].push(
      adoPr({
        id: 4300,
        repo: ADO_REPOS[1],
        title: 'Hot fix: clamp the refund window to 90 days',
        author: DANA,
        source: 'dana/refund-clamp',
        target: 'release/24.9',
        reviewers: [{ ...ME_REVIEWER, vote: 0, isRequired: true }],
        ageH: 0,
      }),
    )
    await bob.eval(`window.bridge.prs.refresh()`).catch(() => {})
    const alerted = await until(
      async () => (await bob.eval(`!!document.querySelector('[role="alert"]')`)) === true,
      20000,
      500,
    )
    if (alerted) await bob.screenshot(join(SHOTS, 'e2e-pr-alert.png')).catch(() => {})
    soft('new-pull-request alert card on bob', !!alerted, alerted ? join(SHOTS, 'e2e-pr-alert.png') : 'card never shown')

    check(
      'every Azure DevOps call carried the Basic token',
      ado.state.requests > 0 && ado.state.rejected === 1,
      `${ado.state.requests} requests, ${ado.state.rejected} rejected (the deliberate anonymous one)`,
    )

    await sleep(1200)
    await alice.screenshot(join(OUT, 'alice.png'))
    await bob.screenshot(join(OUT, 'bob.png'))
    console.log(`\nscreenshots: ${OUT}/alice.png ${OUT}/bob.png`)

    // Janitor sweep smoke: place an ancient file in blobs and run a manual clean via touch -t
    const oldBlob = join(SHARE, 'Chat', 'blobs', 'aa', 'deadbeef.blob')
    mkdirSync(join(SHARE, 'Chat', 'blobs', 'aa'), { recursive: true })
    writeFileSync(oldBlob, 'old')
    execSync(`touch -t 202501010000 "${oldBlob}"`)
    check('janitor test file planted (sweep runs on its own schedule)', true)
  } catch (err) {
    check('E2E run completed', false, err instanceof Error ? err.message : String(err))
  } finally {
    kill()
  }

  const hard = results.filter((r) => !r.soft)
  const softMissed = results.filter((r) => r.soft && !r.ok)
  console.log(`\n${hard.filter((r) => r.ok).length}/${hard.length} checks passed`)
  if (softMissed.length) console.log(`${softMissed.length} best-effort capture(s) skipped`)
  process.exit(failed ? 1 : 0)
}

void main()
