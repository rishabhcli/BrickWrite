import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * The request URL, built without trusting the `Host` header.
 *
 * Every dispatcher used to interpolate `request.headers.host` into the base,
 * which throws `ERR_INVALID_URL` for a header llhttp accepts but WHATWG does
 * not — `Host: a b` is enough. That ran synchronously in the listener, outside
 * any try, so it took the process down rather than answering 400; on the Vercel
 * entry it ran before the proxy-secret check, so it did not even need the
 * secret.
 *
 * A constant base is not a workaround. Nothing downstream reads `host`,
 * `origin` or `protocol` off this URL — the routes only ever read
 * `pathname` — so the header was load-bearing for nothing and trusted anyway.
 */
export function requestUrl(request: Pick<IncomingMessage, 'url'>): URL {
  return new URL(request.url ?? '/', 'http://request.invalid')
}

/** One deadline covers upload, provider work, corrective retries and response assembly. */
export function requestLifetime(request: IncomingMessage, response: ServerResponse, timeoutMs: number) {
  const controller = new AbortController()
  let reason: 'timeout' | 'client' | null = null
  const abort = (why: typeof reason) => {
    if (controller.signal.aborted) return
    reason = why
    controller.abort(
      new DOMException(why === 'timeout' ? 'Request deadline exceeded.' : 'Client disconnected.', 'AbortError'),
    )
  }
  const timer = setTimeout(() => abort('timeout'), timeoutMs)
  timer.unref?.()
  const onClose = () => {
    if (!response.writableFinished) abort('client')
  }
  request.on('aborted', onClose)
  response.on('close', onClose)
  if (request.aborted || response.destroyed) abort('client')
  return {
    signal: controller.signal,
    get reason() {
      return reason
    },
    dispose() {
      clearTimeout(timer)
      request.off('aborted', onClose)
      response.off('close', onClose)
    },
  }
}

export type RequestLifetime = ReturnType<typeof requestLifetime>

/**
 * A positive integer from an environment variable, or the fallback.
 *
 * `Number('')` is 0 and `Number('eight')` is NaN, and `??` catches neither
 * because both are values. Two spend ceilings read their env directly with
 * `Number()`: blanking one made every chat request refuse itself against a
 * budget of zero, and misspelling one made the ceiling disappear — `used >= NaN`
 * is false forever. An invalid value must not raise or remove a limit.
 */
export function boundedCount(value: unknown, fallback: number, max: number): number {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback
}

/**
 * Deadlines, in terms of the same parser.
 *
 * It used to end in `|| 1`, so a value between 0 and 1 became a one-millisecond
 * timer — the exact outcome the comment above forbids. Flooring before the
 * range check makes that a fallback instead.
 */
export const boundedTimeout = (value: unknown, fallback: number): number => boundedCount(value, fallback, 600_000)

export class RequestBodyError extends Error {
  readonly code: 'BAD_REQUEST' | 'PAYLOAD_TOO_LARGE'
  constructor(code: RequestBodyError['code']) {
    super(code === 'PAYLOAD_TOO_LARGE' ? 'Request body exceeds the byte ceiling.' : 'Request body could not be read.')
    this.code = code
  }
}

/** Stop reading without destroying the socket before a useful 413/408 can be sent. */
export function readRequestText(request: IncomingMessage, signal: AbortSignal, maxBytes: number): Promise<string> {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) return Promise.reject(new RequestBodyError('PAYLOAD_TOO_LARGE'))
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const clean = () => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
      request.off('aborted', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const fail = (cause: unknown) => {
      if (settled) return
      settled = true
      clean()
      request.pause()
      reject(cause)
    }
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > maxBytes) {
        fail(new RequestBodyError('PAYLOAD_TOO_LARGE'))
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      clean()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const onError = () => fail(new RequestBodyError('BAD_REQUEST'))
    const onAbort = () => fail(signal.reason)
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('error', onError)
    request.once('aborted', onError)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

/** Blank NDJSON lines keep idle proxies alive without inventing model progress. */
export function ndjsonWriter(response: ServerResponse, signal: AbortSignal, heartbeatMs = 15_000) {
  let closed = false
  const heartbeat = setInterval(
    () => {
      if (
        !closed &&
        !signal.aborted &&
        !response.destroyed &&
        !response.writableEnded &&
        response.writableLength === 0
      ) {
        response.write('\n')
      }
    },
    boundedTimeout(heartbeatMs, 15_000),
  )
  heartbeat.unref?.()
  return {
    write(event: object) {
      if (!closed && !response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`)
    },
    close() {
      closed = true
      clearInterval(heartbeat)
    },
  }
}
