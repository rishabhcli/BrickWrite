/**
 * Edge-side structured logs. Secrets never belong in Cloudflare's log drain.
 */

export function redactEdgeText(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'eyJ***')
    .replace(/BRICKWRIGHT_PROXY_SECRET|x-brickwright-proxy-key/gi, '[REDACTED]')
}

export function logEdgeFailure(event: { readonly path: string; readonly detail: string; readonly cause?: unknown }): void {
  const payload = {
    ts: new Date().toISOString(),
    level: 'error',
    service: 'functions/api',
    path: event.path,
    detail: redactEdgeText(event.detail),
    cause: event.cause === undefined ? undefined : redactEdgeText(event.cause instanceof Error ? event.cause.message : String(event.cause)),
  }
  console.error(JSON.stringify(payload))
}
