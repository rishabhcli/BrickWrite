/**
 * The WebMCP door onto the generation session.
 *
 * The bodies moved to `./host`, which the in-editor Design Partner also calls;
 * this module stays because the gateway's lazy `import()` targets it by name
 * and `src/webmcp/imports.test.ts` asserts it is not in the adapter's static
 * chunk. Re-exporting rather than deleting keeps that boundary provable.
 */
export {
  applyGeneration,
  cancelGeneration,
  compactGeneration,
  compileBriefFromServer,
  compileBriefLocal,
  disposeGenerationHost,
  generationState,
  getGenerationHost,
  getGenerationSession,
  peekGenerationSession,
  previewCandidate,
  runGeneration,
  setGeneration,
  type CompactGeneration,
  type GenerationHost,
  type GenerationSetInput,
} from './host'
