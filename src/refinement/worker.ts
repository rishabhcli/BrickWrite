import { catalog } from '../cad/catalog'
import { loadCompiledCatalog } from '../cad/catalog-loader'
import type { ModelDocument } from '../cad/types'
import { runRefinement, type RefinementRun } from './pipeline'
import type { RefinementProposalV1, RefinementRequestInput } from './types'

/**
 * Running the search off the main thread.
 *
 * A refinement over a real model is hundreds of candidate documents, each with a
 * connector derivation, a collision pass, a statics pass and a rasterized
 * outline. On the main thread that is a visibly frozen viewport for as long as it
 * takes, which is exactly the interaction a "keep refining until it looks right"
 * workflow cannot have.
 *
 * Two details make this a real worker rather than a gesture at one.
 *
 * **The worker loads its own catalog.** A worker starts with an empty module
 * registry, so the compiled catalog the main thread installed is not there. It is
 * fetched and hash-verified inside the worker through the same loader the
 * application uses; nothing is shipped across `postMessage` except the document,
 * the request and the answer, all of which are structured-cloneable.
 *
 * **Cancellation is real.** The client terminates the worker immediately when
 * its signal aborts, because a message cannot interrupt synchronous JavaScript
 * already running on that same worker. The protocol also carries cancellation
 * for jobs still awaiting catalog I/O and for direct hosts that can interleave
 * handler calls.
 *
 * Where `Worker` does not exist — jsdom under Vitest, and any Node consumer — the
 * client runs the identical search inline and says so in its result. That is a
 * fallback for the *environment*, not a second implementation: both paths call
 * `runRefinement`, so a test exercising the fallback is exercising the same code
 * the worker runs.
 */

export interface RefinementSearchMessage {
  readonly kind: 'search'
  readonly jobId: string
  readonly request: RefinementRequestInput
  readonly document: ModelDocument
  /**
   * Where to fetch the compiled catalog from, when the receiving scope has none.
   * Null means "the catalog is already installed here" — which is the case for
   * the inline fallback and for tests.
   */
  readonly catalogBaseUrl: string | null
}

export interface RefinementCancelMessage {
  readonly kind: 'cancel'
  readonly jobId: string
}

export type RefinementWorkerRequest = RefinementSearchMessage | RefinementCancelMessage

export interface RefinementResultMessage {
  readonly kind: 'result'
  readonly jobId: string
  readonly proposals: RefinementProposalV1[]
  readonly report: RefinementRun['report']
  readonly rankingRationale: string
}

export interface RefinementErrorMessage {
  readonly kind: 'error'
  readonly jobId: string
  readonly message: string
}

export interface RefinementCancelledMessage {
  readonly kind: 'cancelled'
  readonly jobId: string
}

export type RefinementWorkerResponse =
  | RefinementResultMessage
  | RefinementErrorMessage
  | RefinementCancelledMessage

export type PostResponse = (response: RefinementWorkerResponse) => void

/** Jobs currently in flight in this scope, so a cancel can reach one. */
const inFlight = new Map<string, AbortController>()

/**
 * Handles one protocol message. This is the worker's whole body.
 *
 * Exported rather than buried in an `onmessage` closure so a test can drive the
 * protocol directly — cancellation included — without needing a worker runtime.
 */
export async function handleRefinementWorkerMessage(
  message: RefinementWorkerRequest,
  post: PostResponse,
): Promise<void> {
  if (message.kind === 'cancel') {
    const controller = inFlight.get(message.jobId)
    if (controller) controller.abort()
    post({ kind: 'cancelled', jobId: message.jobId })
    return
  }

  const controller = new AbortController()
  inFlight.set(message.jobId, controller)
  try {
    // Let a direct host cancel between dispatch and work. A browser client does
    // not rely on this yield for CPU-bound cancellation; it terminates the
    // worker, which is the only way to interrupt synchronous JavaScript.
    await Promise.resolve()
    if (controller.signal.aborted) {
      post({ kind: 'cancelled', jobId: message.jobId })
      return
    }
    if (!catalog.loaded) {
      if (!message.catalogBaseUrl) {
        throw new Error(
          'No compiled catalog is installed in this scope and the job carried no catalog URL to fetch one from.',
        )
      }
      await loadCompiledCatalog(message.catalogBaseUrl)
    }
    const run = runRefinement(message.request, message.document, { signal: controller.signal })
    if (controller.signal.aborted) {
      post({ kind: 'cancelled', jobId: message.jobId })
      return
    }
    post({
      kind: 'result',
      jobId: message.jobId,
      proposals: run.proposals,
      report: run.report,
      rankingRationale: run.rankingRationale,
    })
  } catch (cause) {
    post({ kind: 'error', jobId: message.jobId, message: cause instanceof Error ? cause.message : String(cause) })
  } finally {
    inFlight.delete(message.jobId)
  }
}

/** True when this module is executing inside a worker scope. */
export function inWorkerScope(): boolean {
  return (
    typeof self !== 'undefined' &&
    typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined' &&
    self instanceof (globalThis as unknown as { WorkerGlobalScope: new () => unknown }).WorkerGlobalScope
  )
}

/** Wires the protocol to the worker's message port. Called by the worker entry. */
export function installRefinementWorker(scope: {
  addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void
  postMessage: (message: unknown) => void
}): void {
  scope.addEventListener('message', (event: MessageEvent) => {
    void handleRefinementWorkerMessage(event.data as RefinementWorkerRequest, (response) =>
      scope.postMessage(response),
    )
  })
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface RefinementJobResult {
  readonly proposals: RefinementProposalV1[]
  readonly report: RefinementRun['report']
  readonly rankingRationale: string
  /** How the work actually ran, so a caller is never misled about threading. */
  readonly ranOn: 'worker' | 'inline'
}

export interface RefinementClientOptions {
  readonly catalogBaseUrl?: string | null
  readonly signal?: AbortSignal
  /** Forces the inline path; used by tests that assert the fallback. */
  readonly forceInline?: boolean
}

/** Whether this environment can actually spawn a module worker. */
export function refinementWorkerAvailable(): boolean {
  return typeof Worker !== 'undefined' && typeof URL !== 'undefined'
}

let jobCounter = 0

/**
 * Runs a refinement, on a worker when the environment has one.
 *
 * The inline path is not a stub: it is the same `runRefinement` the worker calls,
 * with the same abort signal, and the result says which path ran so a caller can
 * report honestly rather than claiming a background thread it did not get.
 */
export async function runRefinementJob(
  request: RefinementRequestInput,
  document: ModelDocument,
  options: RefinementClientOptions = {},
): Promise<RefinementJobResult> {
  jobCounter += 1
  const jobId = `refine_${jobCounter}`

  if (options.forceInline || !refinementWorkerAvailable()) {
    const run = runRefinement(request, document, { signal: options.signal })
    return {
      proposals: run.proposals,
      report: run.report,
      rankingRationale: run.rankingRationale,
      ranOn: 'inline',
    }
  }

  const worker = new Worker(new URL('./worker.entry.ts', import.meta.url), { type: 'module' })
  return await new Promise<RefinementJobResult>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        options.signal?.removeEventListener('abort', abortListener)
        worker.terminate()
      }
      const finish = (result: RefinementJobResult) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }
      const fail = (cause: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(cause)
      }
      // Posting a cancel message cannot interrupt `runRefinement`, which is
      // synchronous. Terminating the dedicated one-job worker can and also
      // guarantees no late result is delivered after the caller has left.
      function abortListener() {
        fail(new DOMException('Refinement cancelled.', 'AbortError'))
      }

      worker.addEventListener('message', (event: MessageEvent) => {
        const response = event.data as RefinementWorkerResponse
        if (response.jobId !== jobId) return
        if (response.kind === 'result') {
          finish({
            proposals: response.proposals,
            report: response.report,
            rankingRationale: response.rankingRationale,
            ranOn: 'worker',
          })
          return
        }
        if (response.kind === 'cancelled') fail(new DOMException('Refinement cancelled.', 'AbortError'))
        else fail(new Error(response.message))
      })
      worker.addEventListener('error', (event: ErrorEvent) => {
        fail(new Error(event.message || 'The refinement worker failed to start.'))
      })

      if (options.signal?.aborted) {
        abortListener()
        return
      }
      options.signal?.addEventListener('abort', abortListener, { once: true })
      worker.postMessage({
        kind: 'search',
        jobId,
        request,
        document,
        catalogBaseUrl: options.catalogBaseUrl ?? '',
      } satisfies RefinementSearchMessage)
  })
}
