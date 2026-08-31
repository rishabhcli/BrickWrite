import { hash32, type ModelProvider, type ModelRequest, type ModelResult } from '../platform/contracts'
import type { RawMassingBox } from './phases'

/**
 * A deterministic stand-in for the model, for tests only.
 *
 * It is a *double*, not a fallback: nothing in the runtime path constructs one,
 * and the engine either reaches a real provider or reports itself unavailable.
 * What it exists to prove is the property the pipeline actually claims — that a
 * schema-conforming proposal, whatever produced it, is turned into a physically
 * valid assembly by the deterministic kernel. Pinning the proposal is the only
 * way to test that without a network call deciding whether the suite passes.
 *
 * Its answers are derived from the prompt — the envelope and the seed the
 * pipeline writes into it — so it responds to the brief rather than returning a
 * constant, and its decomposition is deliberately *not* one any built-in
 * strategy produces. Otherwise the model path would be exercising the
 * deterministic path under another name.
 */
export interface TestProviderOptions {
  readonly id?: string
  readonly model?: string
  /** Called for every request, so a test can assert on what was asked. */
  readonly onRequest?: (request: ModelRequest<unknown>) => void
  /** Forces the first N responses to violate the schema, for the retry path. */
  readonly malformedResponses?: number
  /**
   * What the double answers when asked for surface detail.
   *
   * `'legal'` proposes features against the volumes named in the prompt;
   * `'illegal'` answers with a payload `parseDetail` refuses, which is how the
   * fallback to the deterministic surface gets exercised without a network.
   */
  readonly detail?: 'legal' | 'illegal'
}

const DOUBLE_DETAIL_QUERIES = ['grille tile 1 x 2', 'round plate 1 x 1', 'tile 1 x 2', 'slope brick 2 x 2'] as const

/**
 * A surface that varies with the variation seed, like a model's would.
 *
 * Two things matter here. The roles are read back out of the prompt rather than
 * invented, so a proposal never names a volume that does not exist and the
 * fallback host cannot make a test pass for the wrong reason. And the count and
 * the queries are derived from the seed, because a double that answered
 * identically for every candidate would quietly flatten the one property the
 * candidate search exists to provide — that the options genuinely differ.
 */
function doubleDetail(prompt: string): Array<Record<string, unknown>> {
  const volumes = (prompt.match(/Volumes: (.+)\./)?.[1] ?? '')
    .split(';')
    .map((entry) => entry.trim().split(' ')[0])
    .filter(Boolean)
  const roles = volumes.length ? volumes : ['base']
  const seed = readNumber(prompt, /Variation seed:\s*(\d+)/i, 0)
  const count = 2 + (hash32(`detail|${seed}`) % 3)

  return Array.from({ length: count }, (_, index) => {
    const pick = hash32(`detail|${seed}|${index}`)
    return {
      id: `greeble_${index}`,
      role: roles[index % roles.length],
      query: DOUBLE_DETAIL_QUERIES[pick % DOUBLE_DETAIL_QUERIES.length],
      atXStuds: 1 + (pick % 3),
      atZStuds: 0,
      quarterTurns: 0,
    }
  })
}

const readNumber = (text: string, pattern: RegExp, fallback: number): number => {
  const match = text.match(pattern)
  return match ? Number(match[1]) : fallback
}

/** Reads the envelope and seed that the massing prompt states. */
export function parseMassingPrompt(prompt: string): {
  width: number
  depth: number
  courses: number
  seed: number
} {
  const envelope = prompt.match(/Envelope:\s*(\d+)\s*×\s*(\d+)\s*studs,\s*(\d+)\s*courses/)
  return {
    width: envelope ? Number(envelope[1]) : 12,
    depth: envelope ? Number(envelope[2]) : 10,
    courses: envelope ? Number(envelope[3]) : 8,
    seed: readNumber(prompt, /Variation seed:\s*(\d+)/, 0),
  }
}

/**
 * A two-storey decomposition with a stepped upper box.
 *
 * Chosen to be structurally distinct from all three built-in strategies: the
 * upper box is offset asymmetrically along X by an amount the seed decides,
 * which none of the rule sets do.
 */
export function doubleMassing(prompt: string): { boxes: RawMassingBox[] } {
  const { width, depth, courses, seed } = parseMassingPrompt(prompt)
  const lower = Math.max(2, Math.ceil(courses / 2))
  const upper = Math.max(0, courses - lower)
  const boxes: RawMassingBox[] = [
    {
      id: 'hull',
      role: 'base',
      atXStuds: 0,
      atZStuds: 0,
      widthStuds: width,
      depthStuds: depth,
      courses: lower,
      level: 0,
      fill: 'solid',
    },
  ]
  const shift = hash32(`massing|${seed}`) % 3
  const upperWidth = Math.max(3, width - 2 - shift)
  const upperDepth = Math.max(3, depth - 2)
  if (upper >= 2 && upperWidth >= 3 && upperDepth >= 3) {
    boxes.push({
      id: 'cabin',
      role: 'cabin',
      atXStuds: Math.min(shift, Math.max(0, width - upperWidth)),
      atZStuds: 1,
      widthStuds: upperWidth,
      depthStuds: upperDepth,
      courses: upper,
      level: 1,
      fill: 'shell',
    })
  }
  return { boxes }
}

/** Creates the double. Only tests call this. */
export function createTestModelProvider(options: TestProviderOptions = {}): ModelProvider {
  let malformed = options.malformedResponses ?? 0
  return {
    id: options.id ?? 'test-double',
    model: options.model ?? 'deterministic-double/1',
    async complete<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
      options.onRequest?.(request as ModelRequest<unknown>)
      const schema = request.schema as { properties?: Record<string, unknown> } | undefined
      const properties = schema?.properties ?? {}

      let raw: unknown
      if (malformed > 0) {
        malformed -= 1
        raw = { boxes: 'not an array' }
      } else if ('boxes' in properties) {
        raw = doubleMassing(request.prompt)
      } else if ('subject' in properties) {
        raw = {
          subject: request.prompt.replace(/^Request:\s*/i, '').split(/[.,]/)[0].trim().slice(0, 120) || 'unnamed build',
          envelopeWidthStuds: null,
          envelopeHeightStuds: null,
          envelopeDepthStuds: null,
          scale: 'unspecified',
          functions: [],
          paletteColourNames: [],
          symmetry: 'none',
          partBudget: null,
          style: [],
          evidence: [{ field: 'subject', phrase: request.prompt.slice(0, 120) }],
          conflicts: [],
        }
      } else if ('features' in properties) {
        raw =
          options.detail === 'illegal'
            ? { features: [{ id: 'greeble', role: 'base' }] }
            : { features: doubleDetail(request.prompt) }
      } else {
        throw new Error('The test double was asked for a schema it does not implement.')
      }

      const promptHash = hash32(`${request.system} ${request.prompt}`).toString(16).padStart(8, '0')
      return {
        value: request.parse(raw),
        provenance: {
          provider: options.id ?? 'test-double',
          model: options.model ?? 'deterministic-double/1',
          promptHash,
          seed: 0,
          createdAt: new Date(0).toISOString(),
        },
        usage: { inputTokens: request.prompt.length, outputTokens: 0 },
      }
    },
  }
}
