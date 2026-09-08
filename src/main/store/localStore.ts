import { safeStorage, app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, scryptSync } from 'node:crypto'
import { buildAad, decryptRecord, encryptRecord } from '../crypto/envelope'
import { KID } from '@shared/constants'

// Everything the app persists locally lives under userData, encrypted with a
// random Local Master Key (LMK). The LMK itself is sealed by the OS keystore
// (Keychain / DPAPI via Electron safeStorage) — binding local secrets to this
// OS user on this machine; a copied userData folder is useless elsewhere.
// When safeStorage is unavailable (some hardened images), the LMK derives from
// the team passphrase with a per-install salt and must be unlocked each launch.

export type LmkMode = 'safeStorage' | 'passphrase' | 'locked'

const LMK_SEALED = 'lmk.sealed'
const LMK_SALT = 'lmk.salt'
const SETTINGS = 'settings.json'

export class LocalStore {
  private lmk: Buffer | null = null
  private dir: string
  mode: LmkMode = 'locked'

  constructor(dir?: string) {
    this.dir = dir ?? app.getPath('userData')
    mkdirSync(this.dir, { recursive: true })
  }

  /** True once the LMK is available and encrypted files can be read. */
  get unlocked(): boolean {
    return this.lmk !== null
  }

  /** Returns the unlock mode required, initializing the LMK when possible. */
  init(): LmkMode {
    const sealedPath = join(this.dir, LMK_SEALED)
    if (existsSync(sealedPath)) {
      const raw = readFileSync(sealedPath)
      if (raw.subarray(0, 4).toString() === 'PASS') {
        this.mode = 'locked' // passphrase mode — needs unlockWithPassphrase()
        return 'passphrase'
      }
      if (safeStorage.isEncryptionAvailable()) {
        this.lmk = Buffer.from(safeStorage.decryptString(raw), 'base64')
        this.mode = 'safeStorage'
        return 'safeStorage'
      }
      this.mode = 'locked'
      return 'passphrase' // sealed with safeStorage but unavailable now — rare; treated as locked
    }
    // First run: create the LMK
    const lmk = randomBytes(32)
    if (safeStorage.isEncryptionAvailable()) {
      writeFileSync(sealedPath, safeStorage.encryptString(lmk.toString('base64')))
      this.lmk = lmk
      this.mode = 'safeStorage'
      return 'safeStorage'
    }
    // Defer: passphrase mode needs the team passphrase; caller invokes
    // createPassphraseLmk() during onboarding/unlock.
    this.mode = 'locked'
    return 'passphrase'
  }

  createPassphraseLmk(passphrase: string): void {
    const salt = randomBytes(16)
    writeFileSync(join(this.dir, LMK_SALT), salt)
    this.lmk = scryptSync(passphrase.normalize('NFKD'), salt, 32, {
      N: 2 ** 15,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    })
    writeFileSync(join(this.dir, LMK_SEALED), Buffer.concat([Buffer.from('PASS'), randomBytes(4)]))
    // Write a check value so a wrong passphrase is detected on unlock
    this.writeSecret('lmk-check', Buffer.from('ok'))
    this.mode = 'passphrase'
  }

  unlockWithPassphrase(passphrase: string): boolean {
    const salt = readFileSync(join(this.dir, LMK_SALT))
    const candidate = scryptSync(passphrase.normalize('NFKD'), salt, 32, {
      N: 2 ** 15,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    })
    const prev = this.lmk
    this.lmk = candidate
    try {
      const check = this.readSecret('lmk-check')
      if (check?.toString() === 'ok') {
        this.mode = 'passphrase'
        return true
      }
    } catch {
      // fall through
    }
    this.lmk = prev
    return false
  }

  // -------------------------------------------------------------------------

  private secretPath(name: string): string {
    return join(this.dir, `${name}.enc`)
  }

  writeSecret(name: string, data: Buffer): void {
    if (!this.lmk) throw new Error('LocalStore locked')
    const aad = buildAad('local', name, name)
    writeFileSync(this.secretPath(name), encryptRecord(this.lmk, KID.local(name), data, aad))
  }

  readSecret(name: string): Buffer | null {
    if (!this.lmk) throw new Error('LocalStore locked')
    const p = this.secretPath(name)
    if (!existsSync(p)) return null
    const aad = buildAad('local', name, name)
    return decryptRecord(readFileSync(p), this.lmk, aad)
  }

  writeSecretJson(name: string, value: unknown): void {
    this.writeSecret(name, Buffer.from(JSON.stringify(value), 'utf8'))
  }

  readSecretJson<T>(name: string): T | null {
    const buf = this.readSecret(name)
    return buf ? (JSON.parse(buf.toString('utf8')) as T) : null
  }

  deleteSecret(name: string): void {
    rmSync(this.secretPath(name), { force: true })
  }

  // Plaintext settings (theme, notification prefs — no secrets)

  readSettings<T>(): T | null {
    const p = join(this.dir, SETTINGS)
    if (!existsSync(p)) return null
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as T
    } catch {
      return null
    }
  }

  writeSettings(value: unknown): void {
    writeFileSync(join(this.dir, SETTINGS), JSON.stringify(value, null, 2))
  }
}
