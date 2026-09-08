// Single reference table for every protocol constant. Values come from the
// reconciled FDC/1 spec; the share-conformance harness may override the timing
// numbers per deployment (they are read through TeamConfig at runtime).

export const PROTOCOL = {
  name: 'fdc',
  version: 1,
  minReader: 1,
  minWriter: 1,
} as const

/** Share-relative directory layout (under the team root). */
export const DIR = {
  protocolFile: 'protocol.json',
  config: 'config',
  keys: 'keys',
  devices: 'devices',
  beacon: 'beacon',
  channels: 'channels',
  dm: 'dm',
  blobs: 'blobs',
  blobsTmp: 'blobs/tmp',
  drops: 'drops',
  rtc: 'rtc',
  rtcTmp: 'rtc/.tmp',
  screens: 'screens',
  apps: 'apps',
  janitor: 'janitor',
  janitorClaims: 'janitor/claims',
} as const

export const POLL = {
  /** Beacon readdir cadence (ms): focused / default / background window. */
  focusedMs: 1000,
  defaultMs: 1500,
  backgroundMs: 3000,
  /** rtc/ dir cadence while a handshake or live session involves this device. */
  rtcFastMs: 500,
  /** screens/<session> cadence for frame-relay viewers. */
  frameMs: 1000,
  /** Share remount probe while degraded. */
  remountMs: 5000,
  /** apps/version.json stat cadence. */
  updateMs: 5 * 60_000,
} as const

export const BEACON = {
  heartbeatMs: 20_000,
  heartbeatJitterMs: 3_000,
  typingBumpMinMs: 3_000,
  typingTtlMs: 5_000,
  cursorCoalesceMs: 5_000,
  headsRingSize: 16,
} as const

export const PRESENCE = {
  onlineWithinMs: 50_000,
  offlineAfterMs: 120_000,
  awayIdleSec: 300,
} as const

export const HLC = {
  /** Max ms a device may ratchet past the calibrated share clock. */
  maxSkewAheadMs: 5 * 60_000,
} as const

export const EVENT = {
  /** Anything larger goes to the blob store. */
  maxFileBytes: 256 * 1024,
  /** Inline thumbnail budget inside a message event. */
  maxThumbBytes: 24 * 1024,
} as const

export const BLOB = {
  chunkBytes: 1024 * 1024, // SFB1 fixed chunk size
  uploadFailAfterMs: 10 * 60_000,
} as const

export const DROP = {
  autoAcceptDefault: false,
  stalledAfterMs: 2 * 60_000,
  failedAfterMs: 10 * 60_000,
} as const

export const RTC = {
  answerTimeoutMs: 6_000,
  iceConnectTimeoutMs: 5_000,
  disconnectGraceMs: 3_000,
  upgradeRetryAtMs: [30_000, 120_000] as readonly number[],
  meshMaxPeers: 4,
  wsConnectBudgetMs: 750,
  captureMaxWidth: 1920,
  captureMaxHeight: 1080,
  captureMaxFps: 15,
} as const

export const FRAME = {
  intervalMs: 1000,
  maxEdgePx: 1280,
  fallbackEdgePx: 1024,
  quality: 0.6,
  qualitySteps: [0.6, 0.45, 0.35] as readonly number[],
  budgetBytes: 300_000,
  ringDepth: 3,
  viewerHeartbeatMs: 10_000,
  viewerStaleMs: 30_000,
  pausedAfterMs: 5_000,
  endedAfterMs: 30_000,
} as const

export const XFER = {
  chunkBytes: 65_536,
  ackEveryBytes: 8 * 1024 * 1024,
  hiWaterBytes: 8 * 1024 * 1024,
  loWaterBytes: 1 * 1024 * 1024,
  stallMs: 15_000,
  channelOpenTimeoutMs: 3_000,
} as const

/** Default retention (days unless noted); team config can override. */
export const RETENTION = {
  eventDays: 180,
  blobDays: 7,
  dropHours: 72,
  rtcMinutes: 10,
  screensDeadMinutes: 2,
  screensHardHours: 24,
  tmpHours: 24,
  departedBeaconDays: 30,
  janitorClaimHours: 24,
} as const

export const JANITOR = {
  cadenceHours: 6,
  claimWaitMs: 30_000,
  jitterMaxMs: 15 * 60_000,
  compactAfterDays: 2, // day-dirs older than this get bundled
} as const

export const KDF = {
  N: 2 ** 17,
  r: 8,
  p: 1,
  maxmem: 192 * 1024 * 1024,
  saltBytes: 32,
} as const

export const LINKPREVIEW = {
  fetchTimeoutMs: 3_000,
  maxRedirects: 2,
  maxImageBytes: 600 * 1024,
  cardImageW: 360,
  cardImageH: 180,
  maxEmbeddedImageBytes: 24 * 1024,
  domainFailureCacheMs: 60 * 60_000,
} as const

/** Domain-separation tags for Ed25519 signatures. */
export const DST = {
  record: 'smbchat-v1-rec', // generic signed wrapper (events, beacons, config)
  devrec: 'smbchat-v1-devrec',
  rtc: 'smbchat-v1-rtc',
  vouch: 'smbchat-v1-vouch',
  revoke: 'smbchat-v1-revoke',
  release: 'smbchat-v1-release', // apps/version.json
} as const

export const AAD_PREFIX = 'smbchat/v1'
export const HKDF_INFO = {
  file: 'smbchat/v1/file',
  stream: 'smbchat/v1/stream',
  seal: 'smbchat/v1/seal',
  check: 'smbchat/v1/check',
  meta: 'smbchat/v1/meta', // dir tokens — derived from epoch-1 TMK, stable across rotations
  dmRoot: 'smbchat/v1/dm-root',
  dmDirToken: 'dirtoken',
} as const

/** kid (key id) string builders — never contain secret material. */
export const KID = {
  meta: (epoch: number) => `e${epoch}/meta`,
  pres: (epoch: number) => `e${epoch}/pres`,
  conv: (epoch: number, convToken: string) => `e${epoch}/conv/${convToken}`,
  epochs: (epoch: number) => `e${epoch}/epochs`,
  dm: (pairToken: string) => `dm/${pairToken}`,
  blob: (blobIdHex: string) => `blob/${blobIdHex}`,
  seal: (deviceId: string) => `seal/${deviceId.slice(0, 8)}`,
  local: (purpose: string) => `local/${purpose}`,
  frame: (sessionId: string) => `frm/${sessionId}`,
} as const

export const FILE_EXT = {
  record: '.e1',
  signal: '.sig',
  blob: '.blob',
  partial: '.partial',
} as const

export const APP = {
  id: 'com.semaphore.teamchat',
  teamRootDirName: 'Semaphore',
  downloadsSubdir: 'Semaphore',
} as const
