#!/usr/bin/env node
/**
 * Local runner for the Cloudflare Pages Functions in `functions/`.
 *
 * Cloudflare routes a request to a file under `functions/` by path; there is no
 * router to import. So this process reproduces that routing — and nothing else.
 * The handlers it invokes are the *same modules* that deploy to the edge, loaded
 * through Vite's SSR pipeline so the TypeScript and the extensionless imports
 * resolve exactly as the Pages build resolves them.
 *
 * That is the whole point. A dev server with its own reimplementation of the
 * share page would prove nothing about what `brickwrite.tech` serves; this one
 * proves the handler, the access gate, the headers and the rendered HTML,
 * because it runs them.
 *
 * Everything that is not a function route falls through to Vite, which serves
 * the application shell, the compiled catalog under `/catalog`, and the studio
 * harness at `/src/features/share/dev/studio.html`.
 *
 *   node functions/_dev/server.mjs --port 5199 --data .share-dev
 */
import { createServer as createHttpServer } from 'node:http'
import { Readable } from 'node:stream'
import { createServer as createViteServer } from 'vite'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const port = Number.parseInt(flag('port', process.env.SHARE_DEV_PORT ?? '5199'), 10)
const dataDirectory = flag('data', process.env.SHARE_DEV_DATA ?? '.share-dev')
const publishToken = process.env.SHARE_PUBLISH_TOKEN ?? 'dev-publish-token'

const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'warn',
})

const { FileKv } = await vite.ssrLoadModule('/functions/_lib/file-kv.ts')
const env = {
  SHARE_KV: new FileKv(dataDirectory),
  SHARE_PUBLISH_TOKEN: publishToken,
  SHARE_ORIGIN: process.env.SHARE_ORIGIN ?? `http://127.0.0.1:${port}`,
  SHARE_EMBED_ANCESTORS: process.env.SHARE_EMBED_ANCESTORS ?? '',
}

/**
 * The routing table, in Cloudflare's precedence order: an exact file wins over
 * a single-segment parameter, which wins over a catch-all.
 */
const ROUTES = [
  { pattern: ['share', ':slug'], module: '/functions/share/[slug].ts' },
  { pattern: ['share', ':slug', '**rest'], module: '/functions/share/[slug]/[[rest]].ts' },
  { pattern: ['embed', ':slug'], module: '/functions/embed/[slug].ts' },
  { pattern: ['publications', '**route'], module: '/functions/publications/[[route]].ts' },
]

function matchRoute(segments) {
  for (const route of ROUTES) {
    const params = {}
    let index = 0
    let matched = true
    for (const token of route.pattern) {
      if (token.startsWith('**')) {
        params[token.slice(2)] = segments.slice(index)
        index = segments.length
        break
      }
      if (index >= segments.length) {
        matched = false
        break
      }
      if (token.startsWith(':')) params[token.slice(1)] = segments[index]
      else if (token !== segments[index]) {
        matched = false
        break
      }
      index += 1
    }
    // A non-catch-all pattern must consume every segment, or `/share/a/b` would
    // match `/share/:slug` and quietly ignore the rest of the path.
    const consumesAll = route.pattern.some((token) => token.startsWith('**')) || index === segments.length
    if (matched && consumesAll) return { route, params }
  }
  return null
}

async function toFetchRequest(nodeRequest) {
  const url = `http://127.0.0.1:${port}${nodeRequest.url}`
  const headers = new Headers()
  for (const [name, value] of Object.entries(nodeRequest.headers)) {
    if (Array.isArray(value)) for (const entry of value) headers.append(name, entry)
    else if (value !== undefined) headers.set(name, value)
  }
  const method = nodeRequest.method ?? 'GET'
  const hasBody = method !== 'GET' && method !== 'HEAD'
  return new Request(url, {
    method,
    headers,
    body: hasBody ? await readBody(nodeRequest) : undefined,
  })
}

function readBody(nodeRequest) {
  return new Promise((resolve, reject) => {
    const chunks = []
    nodeRequest.on('data', (chunk) => chunks.push(chunk))
    nodeRequest.on('end', () => resolve(Buffer.concat(chunks)))
    nodeRequest.on('error', reject)
  })
}

async function sendResponse(nodeResponse, response, method) {
  const headers = {}
  for (const [name, value] of response.headers) headers[name] = value
  nodeResponse.writeHead(response.status, headers)
  if (method === 'HEAD' || !response.body) {
    nodeResponse.end()
    return
  }
  Readable.fromWeb(response.body).pipe(nodeResponse)
}

const server = createHttpServer((nodeRequest, nodeResponse) => {
  const path = (nodeRequest.url ?? '/').split('?')[0]
  const segments = path.split('/').filter(Boolean)
  const match = matchRoute(segments)

  if (!match) {
    vite.middlewares(nodeRequest, nodeResponse)
    return
  }

  void (async () => {
    try {
      const module = await vite.ssrLoadModule(match.route.module)
      const handler =
        module[`onRequest${(nodeRequest.method ?? 'GET')[0]}${(nodeRequest.method ?? 'GET').slice(1).toLowerCase()}`] ??
        module.onRequest
      if (typeof handler !== 'function') {
        nodeResponse.writeHead(405, { 'Content-Type': 'text/plain' })
        nodeResponse.end(`${nodeRequest.method} is not handled by ${match.route.module}`)
        return
      }
      const request = await toFetchRequest(nodeRequest)
      // The middleware runs first, exactly as Pages runs `_middleware.ts`.
      const middleware = await vite.ssrLoadModule('/functions/_middleware.ts')
      const response = await middleware.onRequest({
        request,
        env,
        params: match.params,
        next: () => handler({ request, env, params: match.params }),
      })
      await sendResponse(nodeResponse, response, nodeRequest.method ?? 'GET')
    } catch (cause) {
      // Local only: the deployed handler funnels everything through
      // `handleError`, which never leaks internals. Here the stack is what a
      // developer needs.
      vite.ssrFixStacktrace?.(cause)
      nodeResponse.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      nodeResponse.end(`Share dev server error:\n${cause?.stack ?? String(cause)}`)
    }
  })()
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(
    `share dev server on http://127.0.0.1:${port}  (data: ${dataDirectory}, publish token: ${publishToken})\n`,
  )
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close()
    void vite.close().then(() => process.exit(0))
  })
}
