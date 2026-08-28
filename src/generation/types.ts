// Generation contracts (Zod schemas) for BrickWrite
import { z } from "zod";

// Basic design brief supplied by user or UI
export const DesignBriefV1 = z.object({
  title: z.string(),
  description: z.string(),
  // Optional seed for reproducibility – if omitted we will hash the brief
  seed: z.number().int().optional(),
  // Expanded fields for spatial agent
  envelope: z.string().optional(), // e.g., "house", "vehicle"
  function: z.string().optional(), // primary function or purpose
  scale: z.string().optional(), // e.g., "1:48"
  style: z.string().optional(), // visual style descriptors
  material: z.string().optional(),
  constraints: z.array(z.string()).optional(), // list of constraints
  references: z.array(z.string()).optional(), // URLs or IDs for reference models
});
export type DesignBriefV1 = z.infer<typeof DesignBriefV1>;

// Provenance data attached to each candidate
export const ProvenanceV1 = z.object({
  model: z.string(), // e.g. "gpt-4o-mini"
  version: z.string().optional(),
  promptHash: z.string(), // SHA256 of the brief JSON
  seed: z.number().int(),
  timestamp: z.string().refine((s) => !isNaN(Date.parse(s)), {
    message: "Invalid ISO timestamp",
  }),
});
export type ProvenanceV1 = z.infer<typeof ProvenanceV1>;

// A generation candidate – expresses a graph of parts/connectors via a placeholder token list
export const GenerationCandidateV1 = z.object({
  id: z.string(), // deterministic id derived from provenance & phase
  provenance: ProvenanceV1,
  // Represented as an array of technique tokens – each token encodes a part identity
  // and optional connector/attachment relationship. The exact grammar is defined
  // elsewhere; we keep it opaque for now.
  tokens: z.array(z.string()),
  // Human‑readable summary for debugging / UI preview
  summary: z.string().optional(),
});
export type GenerationCandidateV1 = z.infer<typeof GenerationCandidateV1>;

// Phase event contracts – emitted by the engine as it produces candidates
export const RoughPhaseEvent = z.object({
  phase: z.literal("rough"),
  candidates: z.array(GenerationCandidateV1),
});
export type RoughPhaseEvent = z.infer<typeof RoughPhaseEvent>;

export const StructurePhaseEvent = z.object({
  phase: z.literal("structure"),
  candidates: z.array(GenerationCandidateV1),
});
export type StructurePhaseEvent = z.infer<typeof StructurePhaseEvent>;

export const DetailPhaseEvent = z.object({
  phase: z.literal("detail"),
  candidates: z.array(GenerationCandidateV1),
});
export type DetailPhaseEvent = z.infer<typeof DetailPhaseEvent>;
