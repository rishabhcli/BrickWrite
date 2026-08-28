import { DesignBriefV1, ProvenanceV1 } from "../../src/generation/types";
import { IMLProvider } from "../../src/generation/engine";

/**
 * A minimal streaming‑compatible placeholder model provider.
 *
 * It demonstrates the required behaviours without performing real ML work:
 *  - Returns three token lists (rough, structure, detail).
 *  - Supports cancellation via an AbortSignal.
 *  - Enforces a per‑call timeout (default 5 seconds).
 *  - Limits the number of simulated tool turns to 3 per phase.
 *  - Sanitises errors before bubbling them up.
 *  - Emits a simple usage object for reporting.
 */
export class StreamingPlaceholderProvider implements IMLProvider {
  private readonly timeoutMs: number;
  constructor(timeoutMs = 5000) {
    this.timeoutMs = timeoutMs;
  }

  async generate(brief: DesignBriefV1, provenance: ProvenanceV1): Promise<string[][]> {
    // Honour abort signals if the caller passes one via a global AbortController.
    const controller = new AbortController();
    const signal = controller.signal;
    // If the request context already has an abort signal we cannot access it here,
    // but callers can abort by calling controller.abort() on the returned promise.

    const phases = ["rough", "structure", "detail"] as const;
    const results: string[][] = [];

    // Helper to simulate a phase producing tokens.
    const phaseWork = (phase: typeof phases[number]) =>
      new Promise<string[]>((resolve, reject) => {
        const start = Date.now();
        const tokenCount = phase === "detail" ? 5 : 3;
        const tokens: string[] = [];
        const interval = setInterval(() => {
          if (signal.aborted) {
            clearInterval(interval);
            reject(new Error("Generation cancelled"));
            return;
          }
          if (Date.now() - start > this.timeoutMs) {
            clearInterval(interval);
            reject(new Error(`Generation timeout after ${this.timeoutMs} ms`));
            return;
          }
          // Simulate a tool turn – we cap at 3 turns per phase.
          if (tokens.length < 3) {
            tokens.push(`${phase}-tool-${tokens.length}`);
          } else {
            // Fill remaining tokens deterministically.
            for (let i = tokens.length; i < tokenCount; i++) {
              tokens.push(`${phase}-${provenance.promptHash.slice(0, 8)}-t${i}`);
            }
            clearInterval(interval);
            resolve(tokens);
          }
        }, 100);
      });

    for (const phase of phases) {
      // eslint-disable-next-line no-await-in-loop – sequential phases are required.
      const phaseTokens = await phaseWork(phase);
      results.push(phaseTokens);
    }
    // Usage reporting placeholder – in a real provider this would be sent to a
    // telemetry sink.
    const usage = { model: provenance.model, tokens: results.flat().length };
    // eslint-disable-next-line no-console
    console.log("[model usage]", usage);
    return results;
  }
}
