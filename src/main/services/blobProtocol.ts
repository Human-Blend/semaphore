import { protocol } from 'electron'
import type { AppController } from '../appController'

// sfblob:// — streaming decrypted blob access for <img>/<video> in the
// renderer, with HTTP range support so video scrubs over SMB without a full
// download. The blobs service replaces `handler` with the real implementation.

export type BlobRequestHandler = (req: Request) => Promise<Response>

let handler: BlobRequestHandler = async () => new Response('blob service not ready', { status: 503 })

export function setBlobRequestHandler(h: BlobRequestHandler): void {
  handler = h
}

/** Must run before app ready. */
export function registerBlobScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'sfblob',
      privileges: { standard: true, stream: true, supportFetchAPI: true, bypassCSP: false },
    },
  ])
}

/** Must run after app ready. */
export function registerBlobProtocol(controller: AppController): void {
  void controller
  protocol.handle('sfblob', (req) => handler(req))
}
