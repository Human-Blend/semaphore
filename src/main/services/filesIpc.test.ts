import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { sanitizeFileName } from './blobs'
import { discardStaged, isStagedPath, sweepStaging } from './filesIpc'

// The local-file side of the diagram paths: the name that gets joined onto a
// directory, and the staging area those files are written into.

const made: string[] = []

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'chat-staging-'))
  made.push(d)
  return d
}

afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true })
})

const hoursAgo = (h: number): Date => new Date(Date.now() - h * 60 * 60 * 1000)

describe('sanitizeFileName', () => {
  // The output is joined onto a directory, so the only acceptable answer is one
  // non-empty segment that cannot walk anywhere.
  const cases: [string, string][] = [
    ['../../etc/passwd', 'a POSIX traversal'],
    ['..\\..\\evil.exe', 'a Windows traversal'],
    ['a/b/c.png', 'a relative path'],
    ['/etc/shadow', 'an absolute path'],
    ['re\u0000port\u001b.png', 'control characters'],
    ['   ', 'nothing but spaces'],
    ['', 'nothing at all'],
    ['..', 'the parent directory'],
    ['.', 'the current directory'],
    ['...', 'a run of dots'],
    ['con:aux*?"<>|.txt', 'shell and NTFS specials'],
  ]

  it.each(cases)('%s (%s) becomes one safe segment', (input) => {
    const out = sanitizeFileName(input)
    expect(out).not.toBe('')
    expect(out).toBe(basename(out))
    expect(out).not.toMatch(/[/\\]/)
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u001f]/)
    expect(out).not.toBe('.')
    expect(out).not.toBe('..')

    const dir = resolve('/tmp/staging/abc')
    expect(resolve(join(dir, out)).startsWith(dir + sep)).toBe(true)
  })

  it('keeps an ordinary name exactly as it is', () => {
    expect(sanitizeFileName('Sprint plan.excalidraw')).toBe('Sprint plan.excalidraw')
    expect(sanitizeFileName('a/b/c.png')).toBe('c.png')
  })
})

describe('sweepStaging', () => {
  it('removes what is older than a day and keeps what is not', async () => {
    const root = tmp()
    const stale = join(root, 'stale')
    const fresh = join(root, 'fresh')
    mkdirSync(stale)
    mkdirSync(fresh)
    writeFileSync(join(stale, 'old.excalidraw'), 'x')
    writeFileSync(join(fresh, 'new.excalidraw'), 'x')
    utimesSync(stale, hoursAgo(25), hoursAgo(25))

    expect(await sweepStaging(Date.now(), root)).toBe(1)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('is idempotent — a second pass finds nothing left to do', async () => {
    const root = tmp()
    const stale = join(root, 'stale')
    mkdirSync(stale)
    utimesSync(stale, hoursAgo(48), hoursAgo(48))

    expect(await sweepStaging(Date.now(), root)).toBe(1)
    expect(await sweepStaging(Date.now(), root)).toBe(0)
    expect(await sweepStaging(Date.now(), root)).toBe(0)
  })

  it('returns 0 when the staging directory does not exist', async () => {
    expect(await sweepStaging(Date.now(), join(tmp(), 'never-created'))).toBe(0)
  })

  it('returns 0 for an empty staging directory', async () => {
    expect(await sweepStaging(Date.now(), tmp())).toBe(0)
  })
})

describe('discardStaged — the uploader deleting what it consumed', () => {
  it('removes the staged file and the per-call directory around it', async () => {
    const root = tmp()
    const dir = join(root, 'deadbeef')
    mkdirSync(dir)
    const file = join(dir, 'Sprint plan.excalidraw')
    writeFileSync(file, '{}')

    expect(await discardStaged(file, root)).toBe(true)
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(root)).toBe(true)
  })

  it('leaves an ordinary attachment (the user’s own file) alone', async () => {
    const root = tmp()
    const elsewhere = tmp()
    const file = join(elsewhere, 'holiday.png')
    writeFileSync(file, 'x')

    expect(await discardStaged(file, root)).toBe(false)
    expect(existsSync(file)).toBe(true)
  })

  it('is idempotent, and quiet about a file that is already gone', async () => {
    const root = tmp()
    const dir = join(root, 'deadbeef')
    mkdirSync(dir)
    const file = join(dir, 'x.excalidraw')
    writeFileSync(file, '{}')

    expect(await discardStaged(file, root)).toBe(true)
    expect(await discardStaged(file, root)).toBe(true)
  })

  it('recognises only paths inside the staging root', () => {
    const root = '/var/userData/staging'
    expect(isStagedPath('/var/userData/staging/abc/x.excalidraw', root)).toBe(true)
    expect(isStagedPath('/var/userData/staging-elsewhere/x', root)).toBe(false)
    expect(isStagedPath('/var/userData/staging', root)).toBe(false)
    expect(isStagedPath('/var/userData/staging/../../etc/passwd', root)).toBe(false)
    expect(isStagedPath('/Users/gil/Pictures/holiday.png', root)).toBe(false)
  })
})
