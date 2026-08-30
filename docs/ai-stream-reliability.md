# Reliable AI request lifetimes

Assistant chat, structured requests, generation, and brief compilation share one
bounded Node-handler lifetime. This improves the operator's experience (no endless
spinner or falsely completed partial reply) and the agent's safety (no tool calls
released from an incomplete turn, and no automatic build commit after a failed
final reply).

## Deadlines and cancellation

- `BRICKWRIGHT_ASSISTANT_TIMEOUT_MS` and `BRICKWRIGHT_GENERATION_TIMEOUT_MS`
  default to **120,000 ms**. The handler deadline starts before reading the body
  and includes provider work, corrective attempts, and result assembly. The
  existing auth/proxy checks run before this handler and are not part of it.
- Invalid, zero, negative, or non-finite values use the default. Positive values
  are capped at 600,000 ms. A configured deadline must still be **below the
  hosting platform's request limit** (`vercel.json` currently sets 300 seconds).
- Browser transports default to **180,000 ms** for the entire exchange, including
  Hexclave credential lookup, fetch, and response reads. This gives the default
  server deadline time to return a useful error. Hosts can set `timeoutMs`; keep
  client and hosting limits above the server deadline when changing defaults.
- Client disconnects and deadline expiry abort the signal passed to the SDK.
  The Pages proxy forwards the incoming signal to its upstream fetch as well.
  Even an SDK that ignores cancellation cannot keep the handler awaiting its
  response or trigger a late corrective call. Provider-side computation/billing
  cancellation remains dependent on the SDK, network, and vendor; these changes
  do not prove a remote generation stopped.
- Idle streaming responses emit a blank NDJSON line every 15 seconds. This is a
  keepalive, **not fabricated model progress**. It does not extend the deadline.
  Heartbeats are skipped when output is already buffered.
- Timers and listeners are released on completion. Browser response readers are
  cancelled on abort, parsing failure, or terminal completion and their locks are
  released. No automatic whole-request retry is introduced, avoiding duplicate
  paid work.

## Failure contract

| Failure | Assistant | Generation / brief |
|---|---|---|
| Body exceeds byte ceiling | HTTP 413, `PAYLOAD_TOO_LARGE` | HTTP 413, `payload_too_large` |
| Upload never finishes | HTTP 408, `TIMEOUT` | HTTP 408, `timeout` |
| Structured provider deadline | HTTP 504, `TIMEOUT` | Not a separate structured route |
| Provider deadline after streaming headers | `error` with `TIMEOUT`, then `done: error` | terminal `error: timeout`, no result |
| Operator cancellation | client reports `aborted`, not provider failure | rejects with the caller's abort reason |
| Client deadline | client reports `TIMEOUT` | rejects with `TimeoutError` |
| Truncated/malformed stream | failed turn; no executable calls released | rejected completion; no value parsed |

Request limits remain 8 MiB for assistant input and 256 KiB for generation/brief
input. Rejected uploads are not reused as keep-alive connections. Transport-level
connection errors are still possible if a peer disconnects while an error is being
returned.

## Completion rules for agent and host integrations

The assistant reader requires a valid `start` followed by well-shaped events and
an explicit `done`. A `tool_use` completion must contain tools; `end_turn` must
not. Duplicate tool IDs, repeated raw turns, unknown events, malformed UTF-8, and
premature EOF fail closed. Text remains visible as it streams, but `onToolCall`
and `onTurn` are delivered only after a valid successful terminal frame. Failed,
refused, aborted, and token-limited turns do not release those callbacks.

The session loop also checks completion independently: a custom transport that
returns without `onDone` cannot make pending Build-mode waves auto-apply. Existing
pending waves remain reviewable; completed edits from earlier work are not undone.

Generation requires a valid `result` or `error`. When present, `accepted.requestId`
must match subsequent IDs. Result-only host streams remain supported. Both
protocol readers stop at the first terminal event instead of waiting for EOF.
They accept CRLF and blank keepalives, enforce **2 MiB per frame / 16 MiB per
stream**, and reject invalid UTF-8. Structured assistant and HTTP error bodies
are capped at **2 MiB**. Wire event names and protocol versions are unchanged.

## Verification and rollout

```sh
npm test -- src/agent src/generation src/platform server/assistant server/generation functions/api --maxWorkers=2 --testTimeout=30000
```

`server/generation/lifecycle.test.ts` uses real Node sockets for hung SDKs,
chat iterator/final-message stalls, slow uploads, declared/chunked oversize input,
disconnects, late responses, and browser-transport-to-handler success paths. Only
the model SDK is stubbed; no key or paid request is needed. Client tests cover
framing, callback safety, reader cleanup, credential/fetch/body deadlines, and
cancellation. Session tests use the real CAD kernel to verify failed final turns
cannot commit pending edits.

Deploy the Node API and Pages/frontend changes together for the complete request
path. No database migration or new service is required. These local tests are not
proof of deployed proxy buffering behavior or live vendor cancellation; verify
those separately on the deployed stack.
