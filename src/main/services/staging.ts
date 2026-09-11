import { app } from 'electron'
import { readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

// The staging area: renderer-produced bytes parked on local disk so they can
// ride the ordinary attachment path (`AttachDraft.path` -> `BlobService.upload`,
// which only stats and streams a file). Today that is one thing — a diagram
// scene too big to travel inside the message — but the rule is the same for
// anything that lands here.
//
// A staged file is consumed within one send: `files:stageBytes` writes it, the
// uploader reads it, and after that it is a plaintext copy of a thing that now
// lives encrypted on the share. It used to be deleted by nothing at all — the
// once-per-launch sweep only removed files older than a day, so a machine that
// stays up for a week accumulated every diagram it had ever sent, in the clear,
// under userData. So: the uploader deletes what it consumed (`discardStaged`),
// and the sweep stays as the backstop for the cases the uploader never reaches
// (a send that failed, a crash between the write and the upload).
//
// Own module so `blobs.ts` can call `discardStaged` without importing
// `filesIpc.ts`, which imports `blobs.ts`.

const STAGING_DIR_NAME = 'staging'

/** Old enough to be debris: nothing legitimately holds a staged file this long. */
export const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function stagingRoot(): string {
  return join(app.getPath('userData'), STAGING_DIR_NAME)
}

/**
 * Is this path one of ours? Compared as a resolved path with a trailing
 * separator, so a sibling directory whose name merely starts with "staging"
 * cannot match — and so nothing outside userData is ever considered for
 * deletion by `discardStaged`.
 */
export function isStagedPath(path: string, root = stagingRoot()): boolean {
  const base = resolve(root) + sep
  return resolve(path).startsWith(base)
}

/**
 * Delete a staged file (and the per-call directory it sits in) once whatever
 * needed it is done. A no-op for any path that is not inside the staging root,
 * and best-effort otherwise: a file another process still holds open is left to
 * the sweep.
 */
export async function discardStaged(path: string, root = stagingRoot()): Promise<boolean> {
  if (!isStagedPath(path, root)) return false
  // `stageBytes` gives every call its own directory under the root, so remove
  // that directory rather than leaving an empty one behind per send. A file
  // sitting directly in the root (nothing writes those today) takes the
  // narrower path: only the file itself.
  const file = resolve(path)
  const dir = dirname(file)
  try {
    await rm(isStagedPath(dir, root) ? dir : file, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Drop staged files left over from earlier runs (or from sends that never
 * reached the uploader). Best-effort by design: a locked file on Windows just
 * waits for the next launch. Returns how many entries it removed; a missing
 * staging root is 0, not an error.
 */
export async function sweepStaging(now = Date.now(), root = stagingRoot()): Promise<number> {
  let removed = 0
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return 0
  }
  for (const name of entries) {
    const p = join(root, name)
    try {
      const st = await stat(p)
      if (now - st.mtimeMs < STAGING_MAX_AGE_MS) continue
      await rm(p, { recursive: true, force: true })
      removed += 1
    } catch {
      // in use, or already gone — idempotent by construction
    }
  }
  return removed
}
