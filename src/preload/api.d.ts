import type { BridgeApi } from '@shared/bridge'

declare global {
  interface Window {
    bridge: BridgeApi
  }
}

export {}
