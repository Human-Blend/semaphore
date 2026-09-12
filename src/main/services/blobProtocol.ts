import { protocol } from 'electron'
import type { AppController } from '../appController'

// sfblob:// — streaming decrypted blob access for <img>/<video> in the
// renderer, with HTTP range support so video scrubs over SMB without a full
// download. The blobs service replaces `handler` with the real implementation.
//
// `corsEnabled` is not decoration. A custom standard scheme is a separate
// origin from the app's own `file://` document, so anything the page reads
// *programmatically* is a cross-origin request: `<img>`/`<video>` are exempt
// (no-cors), but `fetch()` is not, and without this it fails with "Failed to
// fetch" before the handler is ever called. That is what kept blob-backed
// diagram scenes — the only sfblob consumer that reads bytes rather than
// painting them — from ever loading. The handler answers with
// `Access-Control-Allow-Origin`; see BlobService.handleRequest.

export type BlobRequestHandler = (req: Request) => Promise<Response>

let handler: BlobRequestHandler = async () => new Response('blob service not ready', { status: 503 })

export function setBlobRequestHandler(h: BlobRequestHandler): void {
  handler = h
}

/**
 * This scheme's privileges, for the app's single `registerSchemesAsPrivileged`
 * call (src/main/index.ts).
 *
 * It is an entry rather than a `register…()` of its own because Electron allows
 * that call exactly once before `ready`: a second call replaces the lists the
 * renderer is launched with, so registering sfgif afterwards silently took
 * sfblob off the fetch/CORS lists — `<img>` kept working (it goes through the
 * protocol handler either way) while `fetch()` failed with "URL scheme sfblob
 * is not supported", which is precisely what stopped blob-backed diagram
 * scenes from ever loading.
 */
export const blobSchemePrivileges: Electron.CustomScheme = {
  scheme: 'sfblob',
  privileges: { standard: true, stream: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: false },
}

/** Must run after app ready. */
export function registerBlobProtocol(controller: AppController): void {
  void controller
  protocol.handle('sfblob', (req) => handler(req))
}
