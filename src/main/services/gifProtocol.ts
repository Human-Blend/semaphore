import { app, protocol, net } from 'electron'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

// sfgif:// — serves the bundled offline GIF pack to the renderer.
//
// The pack ships inside the app (extraResources), so it works with zero
// connectivity — the target networks block Giphy/Tenor outright. A dedicated
// scheme keeps it out of the CSP's file: exposure and away from the blob
// store's key-bearing URLs.
//
//   sfgif://pack/<id>.gif

export function registerGifScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'sfgif', privileges: { standard: true, supportFetchAPI: true, stream: true } },
  ])
}

export function packDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'gifs-starter')
    : join(process.cwd(), 'resources', 'gifs-starter')
}

export function registerGifProtocol(): void {
  protocol.handle('sfgif', (req) => {
    const url = new URL(req.url)
    // Only plain <id>.gif names — never a path that can escape the pack dir.
    const name = url.pathname.replace(/^\/+/, '')
    if (url.hostname !== 'pack' || !/^[0-9a-f_-]+\.gif$/i.test(name)) {
      return new Response('not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(join(packDir(), name)).toString())
  })
}
