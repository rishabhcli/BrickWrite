/**
 * Structured process logs for the secret-bearing API.
 *
 * Hexclave analytics covers the browser. This process is the one that holds
 * model keys, so every failure has to land in stderr as JSON that an aggregator
 * can scrape — and nothing key-shaped may appear in that JSON.
 */

export function redactLogText(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'eyJ***')
    .replace(/HEXCLAVE_SECRET_SERVER_KEY|ANTHROPIC_API_KEY|BRICKWRIGHT_PROXY_SECRET/g, '[REDACTED_ENV]')
}

export function logProcessEvent(event: {
  readonly level: 'info' | 'error'
  readonly service: string
  readonly message: string
  readonly cause?: unknown
}): void {
  const payload = {
    ts: new Date().toISOString(),
    level: event.level,
    service: event.service,
    message: redactLogText(event.message),
    cause:
      event.cause === undefined
        ? undefined
        : redactLogText(event.cause instanceof Error ? event.cause.stack ?? event.cause.message : String(event.cause)),
  }
  const line = `${JSON.stringify(payload)}\n`
  if (event.level === 'error') process.stderr.write(line)
  else process.stdout.write(line)
}
