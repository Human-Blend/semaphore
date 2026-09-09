import { randomBytes } from 'node:crypto'
import { DIR, KDF, PROTOCOL } from '@shared/constants'
import type { ProtocolFile } from '@shared/types'
import { computeCheck, deriveTmk, verifyCheck } from '../crypto/keys'
import type { ShareIo } from './shareIo'

// Team bootstrap: protocol.json is the single plaintext file at the share
// root. First client creates it with exclusive-create (bootstrap race → the
// loser reads the winner's file and joins).

export interface TeamJoin {
  proto: ProtocolFile
  teamSalt: Buffer
  tmk: Buffer
}

export async function readProtocolFile(io: ShareIo): Promise<ProtocolFile | null> {
  const buf = await io.readMaybe(DIR.protocolFile)
  if (!buf) return null
  try {
    const p = JSON.parse(buf.toString('utf8')) as ProtocolFile
    if (p.protocol !== 'fdc') return null
    return p
  } catch {
    return null
  }
}

export async function createOrJoinTeam(
  io: ShareIo,
  passphrase: string,
  teamName: string,
): Promise<{ join: TeamJoin; created: boolean } | { error: 'wrong-passphrase' | 'incompatible' }> {
  let proto = await readProtocolFile(io)
  let created = false

  if (!proto) {
    const teamSalt = randomBytes(KDF.saltBytes)
    const tmk = deriveTmk(passphrase, teamSalt)
    const candidate: ProtocolFile = {
      protocol: 'fdc',
      version: PROTOCOL.version,
      minReader: PROTOCOL.minReader,
      minWriter: PROTOCOL.minWriter,
      teamId: randomBytes(8).toString('hex'),
      teamName,
      epoch: 1,
      kdf: { alg: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, saltB64: teamSalt.toString('base64') },
      check: computeCheck(tmk, teamSalt).toString('base64'),
      created: Date.now(),
    }
    const won = await io.createExclusive(DIR.protocolFile, Buffer.from(JSON.stringify(candidate, null, 2)))
    if (won) {
      created = true
      proto = candidate
      await ensureLayout(io)
      return { join: { proto, teamSalt, tmk }, created }
    }
    proto = await readProtocolFile(io)
    if (!proto) return { error: 'incompatible' }
  }

  if (proto.version > PROTOCOL.version || proto.minReader > PROTOCOL.version) {
    return { error: 'incompatible' }
  }

  const teamSalt = Buffer.from(proto.kdf.saltB64, 'base64')
  const tmk = deriveTmk(passphrase, teamSalt)
  if (!verifyCheck(tmk, teamSalt, proto.check)) return { error: 'wrong-passphrase' }
  await ensureLayout(io)
  return { join: { proto, teamSalt, tmk }, created }
}

export async function ensureLayout(io: ShareIo): Promise<void> {
  await Promise.all(
    [
      DIR.config,
      DIR.keys,
      DIR.devices,
      DIR.beacon,
      DIR.channels,
      DIR.dm,
      DIR.team,
      DIR.blobs,
      DIR.blobsTmp,
      DIR.drops,
      DIR.rtc,
      DIR.rtcTmp,
      DIR.screens,
      DIR.apps,
      DIR.janitorClaims,
    ].map((d) => io.ensureDir(d)),
  )
}
