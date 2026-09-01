import { createServer, type Server } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createGenerationRoute, type RouteModule } from './index.js'
import type { ProviderConfig } from './anthropic.js'

/**
 * The generation routes on their own server.
 *
 * `server/index.ts` is the real entry point and discovers every route module;
 * this exists for the two cases where that is the wrong tool. A test needs to
 * bind a port, drive the actual handler and shut it down again without the other
 * workstreams' modules deciding whether it can boot at all. And an operator
 * checking whether generation is configured wants to start exactly the thing
 * they are checking.
 *
 * It is the same `RouteModule` in both cases — nothing is re-implemented here —
 * so a green test here is a statement about the code that ships.
 */

export interface StandaloneOptions {
  readonly port?: number
  readonly host?: string
  /** Injected by tests; production reads the environment. */
  readonly providerConfig?: ProviderConfig
}

export interface StandaloneServer {
  readonly server: Server
  readonly port: number
  readonly url: string
  close(): Promise<void>
}

export function createGenerationServer(options: StandaloneOptions = {}): Promise<StandaloneServer> {
  const route: RouteModule = createGenerationRoute(
    options.providerConfig ? { providerConfig: options.providerConfig } : {},
  )
  const host = options.host ?? '127.0.0.1'

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`)
    if (url.pathname === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, routes: [route.prefix] }))
      return
    }
    void (async () => {
      try {
        if (await route.handle(request, response, url)) return
      } catch (cause) {
        // Mirrors the shell's own guard: the log keeps the detail, the client
        // gets a code.
        process.stderr.write(`[generation] ${url.pathname} failed: ${String(cause)}\n`)
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'internal_error' }))
        } else {
          response.end()
        }
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not_found', detail: `No generation route claimed ${url.pathname}` }))
    })()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // Port 0 asks the OS for a free one, so parallel test files cannot collide
    // on a hard-coded number.
    server.listen(options.port ?? 0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        server,
        port,
        url: `http://${host}:${port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((cause) => (cause ? fail(cause) : done()))
            server.closeAllConnections?.()
          }),
      })
    })
  })
}

/** `node server/generation/serve.ts` starts generation alone, for a quick check. */
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.BRICKWRIGHT_GENERATION_PORT ?? 8788)
  createGenerationServer({ port })
    .then((running) => {
      process.stdout.write(`[generation] listening on ${running.url}\n`)
    })
    .catch((cause: unknown) => {
      process.stderr.write(`[generation] failed to start: ${String(cause)}\n`)
      process.exitCode = 1
    })
}
