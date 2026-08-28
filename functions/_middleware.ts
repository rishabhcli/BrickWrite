/**
 * Baseline headers for everything under `functions/`.
 *
 * The route handlers set their own, more specific policy — a share page needs a
 * different CSP from a PNG. This middleware is the floor: it guarantees that
 * *any* response leaving this surface, including one produced by an unhandled
 * path or by the platform itself, carries `nosniff` and a referrer policy.
 *
 * It never overwrites a header a handler already set.
 */
export const onRequest = async (context: {
  request: Request
  next: () => Promise<Response>
}): Promise<Response> => {
  const response = await context.next()
  const headers = new Headers(response.headers)
  const floor: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  }
  for (const [name, value] of Object.entries(floor)) {
    if (!headers.has(name)) headers.set(name, value)
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
