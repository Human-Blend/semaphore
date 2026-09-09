import { describe, expect, it } from 'vitest'
import { DIR } from '@shared/constants'
import { SWEEP_EVENT_ROOTS } from './janitor'

// The retention sweep deletes whole event day-dirs. Team logs (calendar,
// PR-group config) are app state, not chatter: a birthday entered two years ago
// sits in a single old day-dir and must survive forever. Guard the list so a
// future "sweep every conv scope" refactor fails here instead of on a share.

describe('janitor sweep roots', () => {
  it('sweeps channels and dms', () => {
    expect(SWEEP_EVENT_ROOTS).toContain(DIR.channels)
    expect(SWEEP_EVENT_ROOTS).toContain(DIR.dm)
  })

  it('never sweeps the team log dir', () => {
    expect(SWEEP_EVENT_ROOTS).not.toContain(DIR.team)
    expect(SWEEP_EVENT_ROOTS).toEqual([DIR.channels, DIR.dm])
  })

  it('never sweeps apps/', () => {
    expect(SWEEP_EVENT_ROOTS).not.toContain(DIR.apps)
  })
})
