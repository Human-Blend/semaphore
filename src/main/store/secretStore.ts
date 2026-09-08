// Interface for the encrypted local store — lets transport code run in tests
// without the Electron runtime (LocalStore implements this with safeStorage).

export interface SecretStore {
  readonly unlocked: boolean
  writeSecret(name: string, data: Buffer): void
  readSecret(name: string): Buffer | null
  writeSecretJson(name: string, value: unknown): void
  readSecretJson<T>(name: string): T | null
  deleteSecret(name: string): void
}
