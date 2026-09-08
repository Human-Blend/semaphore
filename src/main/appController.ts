import { app, BrowserWindow, dialog } from 'electron'
import { homedir } from 'node:os'
import type { BootMode, OnboardHealth, PushMessage, SelfView, SettingsView } from '@shared/bridge'
import { APP } from '@shared/constants'
import { LocalStore } from './store/localStore'
import { ShareIo } from './transport/shareIo'
import { createOrJoinTeam, readProtocolFile } from './transport/bootstrap'
import { Roster } from './transport/roster'
import { Session } from './transport/session'
import { ChatService } from './services/chatService'
import { Janitor } from './services/janitor'
import { UpdateService } from './services/updates'
import {
  currentHostname,
  gatherMachineIdHash,
  generateIdentity,
  identityFromStored,
  type DeviceIdentity,
  type StoredIdentity,
} from './crypto/identity'
import { deriveTeamKeys } from './crypto/keys'
import { sanitizeHostname } from '@shared/ids'

// Boot state machine + service owner. Everything IPC handlers touch lives here.

interface AppConfig {
  sharePath: string
  displayName: string
  teamName: string
}

interface CachedTeam {
  tmkB64: string
  tmk1B64: string
  epoch: number
}

const DEFAULT_SETTINGS: SettingsView = {
  theme: 'system',
  notifyChannels: 'mentions',
  notifyPreviews: true,
  autoplayGifs: 'always',
  autoAcceptBeams: false,
  quietHours: { enabled: false, from: '18:30', to: '09:00' },
  fontSize: 'M',
}

export class AppController {
  readonly store = new LocalStore()
  chat: ChatService | null = null
  session: Session | null = null
  janitor: Janitor | null = null
  updates: UpdateService | null = null
  private identity: DeviceIdentity | null = null
  private settings: SettingsView = DEFAULT_SETTINGS
  private boot: BootMode = { mode: 'onboarding', sharePathSuggestion: null }
  private push: (msg: PushMessage) => void = () => {}

  constructor(private getWindow: () => BrowserWindow | null) {}

  setPush(push: (msg: PushMessage) => void): void {
    this.push = push
    this.chat?.setPush(push)
  }

  getBoot(): BootMode {
    return this.boot
  }

  getSettings(): SettingsView {
    return this.settings
  }

  setSettings(patch: Partial<SettingsView>): SettingsView {
    this.settings = { ...this.settings, ...patch }
    this.store.writeSettings(this.settings)
    return this.settings
  }

  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    const mode = this.store.init()
    this.settings = { ...DEFAULT_SETTINGS, ...(this.store.readSettings<Partial<SettingsView>>() ?? {}) }

    if (mode === 'passphrase' && !this.store.unlocked) {
      this.boot = { mode: 'locked' }
      return
    }
    await this.tryStartFromSavedConfig()
  }

  private async tryStartFromSavedConfig(): Promise<void> {
    const config = this.store.readSecretJson<AppConfig>('app-config')
    if (!config) {
      this.boot = { mode: 'onboarding', sharePathSuggestion: null, savedName: null }
      return
    }
    try {
      await this.startSession(config)
    } catch (err) {
      // Share unreachable at launch → still enter the app in degraded mode?
      // v1: fall back to onboarding-with-error only if config is unusable;
      // for a missing mount, surface ready-with-degraded later. Keep simple:
      this.boot = { mode: 'onboarding', sharePathSuggestion: config.sharePath, savedName: config.displayName }
    }
  }

  /**
   * Disconnect from the current team folder and re-enter setup. The device
   * identity and display name are kept; team-scoped local state is cleared.
   * Old messages stay (encrypted) in the old folder — nothing is deleted.
   */
  async changeTeamFolder(): Promise<void> {
    const config = this.store.readSecretJson<AppConfig>('app-config')
    this.janitor?.stop()
    this.updates?.stop()
    await this.chat?.stop().catch(() => {})
    this.chat = null
    this.session = null
    this.janitor = null
    this.updates = null
    for (const secret of ['app-config', 'team-cache', 'sender-seqs', 'beacon-seq', 'outbox']) {
      this.store.deleteSecret(secret)
    }
    this.boot = {
      mode: 'onboarding',
      sharePathSuggestion: config?.sharePath ?? null,
      savedName: config?.displayName ?? null,
    }
    this.push({ kind: 'boot', boot: this.boot })
  }

  async unlock(passphrase: string): Promise<boolean> {
    const ok = this.store.unlockWithPassphrase(passphrase)
    if (ok) {
      await this.tryStartFromSavedConfig()
      this.push({ kind: 'boot', boot: this.boot })
    }
    return ok
  }

  // -------------------------------------------------------------------------
  // Onboarding

  async pickFolder(): Promise<string | null> {
    const win = this.getWindow()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose the shared team folder',
      defaultPath: homedir(),
      properties: ['openDirectory', 'createDirectory'],
    })
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0]
  }

  async healthCheck(path: string): Promise<OnboardHealth> {
    const io = new ShareIo(this.teamRoot(path))
    const health = await io.healthCheck()
    const proto = await readProtocolFile(io)
    return { ...health, existingTeamName: proto?.teamName ?? null }
  }

  private teamRoot(sharePath: string): string {
    // The app owns a subfolder inside whatever share the user picked, unless
    // they picked a folder that already IS a team root.
    return sharePath.endsWith(APP.teamRootDirName) ? sharePath : `${sharePath}/${APP.teamRootDirName}`
  }

  async onboardSubmit(cfg: {
    sharePath: string
    passphrase: string
    displayName: string
    teamName: string
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      if (!this.store.unlocked) {
        // No safeStorage on this machine: derive the local key from the team
        // passphrase (typed each launch).
        this.store.createPassphraseLmk(cfg.passphrase)
      }
      const root = this.teamRoot(cfg.sharePath)
      const io = new ShareIo(root)
      await io.ensureDir('')
      const result = await createOrJoinTeam(io, cfg.passphrase, cfg.teamName || 'Team')
      if ('error' in result) {
        return { ok: false, error: result.error === 'wrong-passphrase' ? 'That passphrase does not match this team folder.' : 'This team folder needs a newer version of Semaphore.' }
      }
      const { proto, tmk } = result.join
      const config: AppConfig = { sharePath: root, displayName: cfg.displayName, teamName: proto.teamName }
      this.store.writeSecretJson('app-config', config)
      this.store.writeSecretJson('team-cache', {
        tmkB64: tmk.toString('base64'),
        tmk1B64: tmk.toString('base64'),
        epoch: proto.epoch,
      })
      await this.startSession(config, io)
      this.push({ kind: 'boot', boot: this.boot })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not join the team folder.' }
    }
  }

  // -------------------------------------------------------------------------

  private async startSession(config: AppConfig, existingIo?: ShareIo): Promise<void> {
    const io = existingIo ?? new ShareIo(config.sharePath)
    const proto = await readProtocolFile(io)
    if (!proto) throw new Error('team folder unreachable or not initialized')

    const cached = this.store.readSecretJson<CachedTeam>('team-cache')
    if (!cached) throw new Error('no cached team key — passphrase required')
    const tmk = Buffer.from(cached.tmkB64, 'base64')
    const tmk1 = Buffer.from(cached.tmk1B64, 'base64')
    const teamSalt = Buffer.from(proto.kdf.saltB64, 'base64')

    // Identity: load or create once
    let storedId = this.store.readSecretJson<StoredIdentity>('identity')
    if (!storedId) {
      const gen = generateIdentity()
      storedId = gen.stored
      this.store.writeSecretJson('identity', storedId)
    }
    this.identity = identityFromStored(storedId)

    const keys = deriveTeamKeys(proto.epoch, tmk, tmk1, teamSalt)
    const roster = new Roster(io, this.store, keys.kMeta, proto.epoch)
    roster.loadPins()
    const session = new Session(io, this.store, this.identity, proto, teamSalt, tmk, tmk1, roster, config.displayName)

    // Publish/refresh our registration
    const machineIdHash = await gatherMachineIdHash()
    const prevSeq = this.store.readSecretJson<number>('rec-seq') ?? 0
    this.store.writeSecretJson('rec-seq', prevSeq + 1)
    await roster.publishSelf(this.identity, {
      deviceId: this.identity.deviceId,
      edPub: this.identity.edPub,
      xPub: this.identity.xPub,
      displayName: config.displayName,
      hostname: currentHostname(),
      osUser: process.env.USER ?? process.env.USERNAME ?? '',
      platform: process.platform as 'darwin' | 'win32' | 'linux',
      machineIdHash,
      firstSeen: this.store.readSecretJson<number>('first-seen') ?? Date.now(),
      recSeq: prevSeq + 1,
    })
    if (!this.store.readSecretJson('first-seen')) this.store.writeSecretJson('first-seen', Date.now())

    this.session = session
    this.chat = new ChatService(session, this.getWindow, () => this.settings)
    this.chat.setPush((msg) => this.push(msg))
    await this.chat.start()

    this.janitor = new Janitor(session)
    this.janitor.start()
    this.updates = new UpdateService(session, (msg) => this.push(msg))
    this.updates.start()

    this.boot = { mode: 'ready', self: this.selfView(config, proto.teamName) }
  }

  private selfView(config: AppConfig, teamName: string): SelfView {
    const id = this.identity!
    return {
      deviceId: id.deviceId,
      displayName: config.displayName,
      hostname: sanitizeHostname(currentHostname()),
      fingerprint: id.fingerprint,
      teamName,
      sharePath: config.sharePath,
      platform: process.platform as 'darwin' | 'win32' | 'linux',
    }
  }

  async shutdown(): Promise<void> {
    this.janitor?.stop()
    this.updates?.stop()
    await this.chat?.stop().catch(() => {})
  }
}

export function detectDevice(): { hostname: string } {
  return { hostname: sanitizeHostname(currentHostname()) }
}

export { app }
