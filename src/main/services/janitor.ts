import { DIR, JANITOR, RETENTION } from '@shared/constants'
import { parseBeaconFileName } from '@shared/ids'
import type { Session } from '../transport/session'

// Cooperative cleanup: any client noticing last-run.json is stale becomes a
// candidate, waits a random jitter, writes a claim, and the lowest claim
// filename wins. Double-winners are harmless — every delete is idempotent and
// the criteria are deterministic. apps/** is never touched.

interface LastRun {
  by: string
  at: number
  deleted: Record<string, number>
}

/**
 * The only scopes whose event day-dirs are swept past retention.
 *
 * `DIR.team` is deliberately absent and must stay absent: the team logs are
 * app state, not conversation history. A birthday entered two years ago, or a
 * PR-group config published once and never touched again, lives in exactly one
 * old day-dir — sweeping it would silently erase the calendar and disconnect
 * the whole team from Azure DevOps. Retention applies to chatter only.
 * Asserted by janitor.test.ts.
 */
export const SWEEP_EVENT_ROOTS: readonly string[] = [DIR.channels, DIR.dm, DIR.groups]

export class Janitor {
  private timer: NodeJS.Timeout | null = null
  private running = false
  /**
   * Conversations tombstoned by a `channel-deleted` / `group-deleted` event,
   * supplied by ChatService (which holds the folded state). The janitor removes
   * the directory once `RETENTION.deletedConvGraceDays` have passed — the delay
   * is what lets a client that was offline still read the tombstone and hide
   * the conversation for itself.
   */
  deletedConvs: (() => { rel: string; deletedAt: number }[]) | null = null

  constructor(private session: Session) {}

  start(): void {
    // First check shortly after launch, then every 30 minutes.
    this.timer = setInterval(() => void this.maybeRun(), 30 * 60_000)
    setTimeout(() => void this.maybeRun(), 60_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private async maybeRun(): Promise<void> {
    if (this.running) return
    const s = this.session
    try {
      const lastRaw = await s.io.readMaybe(`${DIR.janitor}/last-run.json`)
      if (lastRaw) {
        try {
          const last = JSON.parse(lastRaw.toString()) as LastRun
          const stat = await s.io.statMaybe(`${DIR.janitor}/last-run.json`)
          const age = s.io.calibratedNow() - (stat?.mtimeMs ?? last.at)
          if (age < JANITOR.cadenceHours * 3_600_000) return
        } catch {
          // corrupt — treat as stale
        }
      }
      this.running = true
      // Jitter, then claim
      await sleep(Math.random() * JANITOR.jitterMaxMs)
      // Re-check after jitter — someone may have finished meanwhile
      const stat2 = await s.io.statMaybe(`${DIR.janitor}/last-run.json`)
      if (stat2 && s.io.calibratedNow() - stat2.mtimeMs < JANITOR.cadenceHours * 3_600_000) return

      const claimName = `${String(s.io.calibratedNow()).padStart(13, '0')}-${s.deviceId8}`
      await s.io.publish(`${DIR.janitorClaims}/${claimName}`, Buffer.from('claim'))
      await sleep(JANITOR.claimWaitMs)
      const claims = (await s.io.list(DIR.janitorClaims)).sort()
      if (claims[0] !== claimName) {
        await s.io.delete(`${DIR.janitorClaims}/${claimName}`)
        return // lost the lottery
      }

      const deleted = await this.sweep()
      const receipt: LastRun = { by: s.deviceId, at: s.io.calibratedNow(), deleted }
      await s.io.publish(`${DIR.janitor}/last-run.json`, Buffer.from(JSON.stringify(receipt)))
      await s.io.delete(`${DIR.janitorClaims}/${claimName}`)
    } catch {
      // janitor failures are always safe to ignore
    } finally {
      this.running = false
    }
  }

  /** The deterministic sweep. Exposed for tests. */
  async sweep(): Promise<Record<string, number>> {
    const s = this.session
    const now = s.io.calibratedNow()
    const config = await retentionFor(s)
    const counts: Record<string, number> = { events: 0, convs: 0, blobs: 0, drops: 0, rtc: 0, screens: 0, boards: 0, tmp: 0, beacons: 0, claims: 0 }

    const olderThan = async (rel: string, ms: number): Promise<boolean> => {
      const st = await s.io.statMaybe(rel)
      return !!st && now - st.mtimeMs > ms
    }

    // Event day-dirs beyond retention — delete whole day directories.
    // Channels and DMs only (see SWEEP_EVENT_ROOTS): team/ is never swept.
    const eventCutoffDay = dayString(now - config.eventDays * 86_400_000)
    for (const scope of SWEEP_EVENT_ROOTS) {
      for (const convDir of await s.io.listDirs(scope)) {
        const eventsRel = `${scope}/${convDir}/events`
        for (const day of await s.io.listDirs(eventsRel)) {
          if (day < eventCutoffDay) {
            if ((await s.io.delete(`${eventsRel}/${day}`)) === 'deleted') counts.events++
          }
        }
      }
    }

    // Deleted conversations: the whole directory goes, grace period passed.
    // Idempotent like every other delete — a Windows EBUSY just retries next run.
    //
    // Two clocks have to agree before anything is removed. `deletedAt` comes
    // from the tombstone's *filename* — an HLC stamp its writer chose, so a
    // client with a badly wrong clock (or one being deliberate) can publish a
    // `channel-deleted` dated last month and have the directory swept the same
    // hour, taking the grace period — the whole point of which is to let an
    // offline client come back and read the tombstone — with it. The directory's
    // own mtime is the share's answer to the same question, and costs one stat.
    const graceMs = RETENTION.deletedConvGraceDays * 86_400_000
    for (const conv of this.deletedConvs?.() ?? []) {
      if (now - conv.deletedAt <= graceMs) continue
      if (!(await olderThan(conv.rel, graceMs))) continue
      if ((await s.io.delete(conv.rel)) === 'deleted') counts.convs++
    }

    // Blobs older than retention (skip tmp — separate rule)
    for (const shard of await s.io.listDirs(DIR.blobs)) {
      if (shard === 'tmp') continue
      for (const name of await s.io.list(`${DIR.blobs}/${shard}`)) {
        const rel = `${DIR.blobs}/${shard}/${name}`
        if (await olderThan(rel, config.blobDays * 86_400_000)) {
          if ((await s.io.delete(rel)) === 'deleted') counts.blobs++
        }
      }
    }

    // Drops
    for (const inbox of await s.io.listDirs(DIR.drops)) {
      for (const name of await s.io.list(`${DIR.drops}/${inbox}`)) {
        const rel = `${DIR.drops}/${inbox}/${name}`
        if (await olderThan(rel, config.dropHours * 3_600_000)) {
          if ((await s.io.delete(rel)) === 'deleted') counts.drops++
        }
      }
    }

    // RTC signals
    for (const name of await s.io.list(DIR.rtc)) {
      if (name === '.tmp') continue
      if (await olderThan(`${DIR.rtc}/${name}`, RETENTION.rtcMinutes * 60_000)) {
        if ((await s.io.delete(`${DIR.rtc}/${name}`)) === 'deleted') counts.rtc++
      }
    }

    // Screen sessions: dead (newest frame stale) or over hard TTL
    for (const sess of await s.io.listDirs(DIR.screens)) {
      const rel = `${DIR.screens}/${sess}`
      const names = await s.io.list(rel)
      let newest = 0
      for (const n of names) {
        const st = await s.io.statMaybe(`${rel}/${n}`)
        if (st && st.mtimeMs > newest) newest = st.mtimeMs
      }
      const dead = names.length === 0 || now - newest > RETENTION.screensDeadMinutes * 60_000
      const hard = await olderThan(rel, RETENTION.screensHardHours * 3_600_000)
      if (dead || hard) {
        if ((await s.io.delete(rel)) === 'deleted') counts.screens++
      }
    }

    // Live boards (1.3): the same rule as screens, with two differences. A board
    // directory is created by `start` before anyone has drawn anything, so an
    // EMPTY dir is not evidence of a dead session — its own mtime is. A dir
    // whose newest frame has gone quiet means everyone left (or crashed)
    // without the host ending the session.
    //
    // And the hard limit is read off the OLDEST frame, never off the directory:
    // a live board rewrites its directory constantly (every publish renames a
    // file in, every writer deletes its previous one), and each of those bumps
    // the directory's mtime — so a `statMaybe(rel)` age could never exceed a few
    // seconds while anyone was drawing, and the hard limit could not fire at
    // all. The oldest frame still in the dir is the share's own record of how
    // long this session has been going; `board-live`'s `startedAt` would say it
    // too, but the janitor reads directories, not conversation logs.
    const deadMs = RETENTION.boardsDeadMinutes * 60_000
    const hardMs = RETENTION.boardsHardHours * 3_600_000
    for (const sess of await s.io.listDirs(DIR.boards)) {
      const rel = `${DIR.boards}/${sess}`
      const names = await s.io.list(rel)
      if (names.length === 0) {
        if (await olderThan(rel, deadMs)) {
          if ((await s.io.delete(rel)) === 'deleted') counts.boards++
        }
        continue
      }
      let newest = 0
      let oldest = Number.POSITIVE_INFINITY
      for (const n of names) {
        const st = await s.io.statMaybe(`${rel}/${n}`)
        if (!st) continue
        if (st.mtimeMs > newest) newest = st.mtimeMs
        if (st.mtimeMs < oldest) oldest = st.mtimeMs
      }
      const dead = now - newest > deadMs
      const hard = Number.isFinite(oldest) && now - oldest > hardMs
      if (dead || hard) {
        if ((await s.io.delete(rel)) === 'deleted') counts.boards++
      }
    }

    // Tmp debris: blobs/tmp entries and stray .partial anywhere top-level
    for (const name of await s.io.list(DIR.blobsTmp)) {
      if (await olderThan(`${DIR.blobsTmp}/${name}`, RETENTION.tmpHours * 3_600_000)) {
        if ((await s.io.delete(`${DIR.blobsTmp}/${name}`)) === 'deleted') counts.tmp++
      }
    }

    // Beacons of departed devices
    for (const name of await s.io.list(DIR.beacon)) {
      const parsed = parseBeaconFileName(name)
      if (!parsed) continue
      if (await olderThan(`${DIR.beacon}/${name}`, RETENTION.departedBeaconDays * 86_400_000)) {
        if ((await s.io.delete(`${DIR.beacon}/${name}`)) === 'deleted') counts.beacons++
      }
    }
    // Duplicate beacons per device (crash artifacts): keep highest seq
    const bySeq = new Map<string, { seq: number; name: string }[]>()
    for (const name of await s.io.list(DIR.beacon)) {
      const p = parseBeaconFileName(name)
      if (!p) continue
      const arr = bySeq.get(p.deviceId8) ?? []
      arr.push({ seq: p.seq, name })
      bySeq.set(p.deviceId8, arr)
    }
    for (const arr of bySeq.values()) {
      if (arr.length <= 1) continue
      arr.sort((a, b) => b.seq - a.seq)
      for (const stale of arr.slice(1)) {
        if ((await s.io.delete(`${DIR.beacon}/${stale.name}`)) === 'deleted') counts.beacons++
      }
    }

    // Stale claims
    for (const name of await s.io.list(DIR.janitorClaims)) {
      if (await olderThan(`${DIR.janitorClaims}/${name}`, RETENTION.janitorClaimHours * 3_600_000)) {
        if ((await s.io.delete(`${DIR.janitorClaims}/${name}`)) === 'deleted') counts.claims++
      }
    }

    // NOTE: apps/** and team/** deliberately untouched. Day-bundle compaction is a v2
    // optimization for multi-month cold starts.
    return counts
  }
}

function dayString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Retention with team-config overrides. */
export async function retentionFor(
  session: Session,
): Promise<{ eventDays: number; blobDays: number; dropHours: number }> {
  const cfg = await session.readTeamConfig()
  return {
    eventDays: cfg?.retention?.eventDays ?? RETENTION.eventDays,
    blobDays: cfg?.retention?.blobDays ?? RETENTION.blobDays,
    dropHours: cfg?.retention?.dropHours ?? RETENTION.dropHours,
  }
}
