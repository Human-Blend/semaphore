import { safeStorage } from 'electron'

// The OS-backed seal for the Local Master Key. Kept behind an interface so
// LocalStore is testable without Electron and so the platform decision below
// lives in exactly one place.

export interface OsKeystore {
  available(): boolean
  seal(plain: Buffer): Buffer
  open(sealed: Buffer): Buffer
}

/**
 * Which OS keystore this platform gets — or none, meaning the LMK is wrapped
 * under the team passphrase and unlocked at each launch instead.
 *
 * Windows: DPAPI via safeStorage. Per-user, silent, survives app updates.
 *
 * macOS: deliberately none. safeStorage there is a Keychain item whose ACL is
 * bound to the app's code signature, and our builds are ad-hoc signed — every
 * version has a different cdhash. Verified on the build Mac: the first launch
 * of a new build gets "Semaphore wants to use your confidential information
 * stored in 'Semaphore Safe Storage'" (with a password prompt on Always
 * Allow), the check blocks the main process before any window exists, and a
 * Deny leaves the sealed LMK unopenable forever. A passphrase at launch is
 * the honest trade: no system dialogs, nothing breaks on update, and the key
 * never touches disk.
 */
export function platformKeystore(): OsKeystore | null {
  if (process.platform === 'darwin') return null
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    seal: (plain) => safeStorage.encryptString(plain.toString('base64')),
    open: (sealed) => Buffer.from(safeStorage.decryptString(sealed), 'base64'),
  }
}
