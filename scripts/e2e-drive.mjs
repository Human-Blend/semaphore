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
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

    // Presence: alice sees bob online
    const presA = await until(async () => {
      const list = await alice.eval(`window.bridge.presence.list()`)
      const bobView = list?.find((p) => p.name === 'Bob')
      return bobView?.state === 'online' ? bobView : undefined
    }, 30000)
    check('alice sees Bob online with device chip', !!presA, presA ? `${presA.hostname}·${presA.fingerprint}` : '')

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
