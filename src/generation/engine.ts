import { EventEmitter } from "events";
import { createHash } from "crypto";
import { DesignBriefV1, GenerationCandidateV1, ProvenanceV1, RoughPhaseEvent, StructurePhaseEvent, DetailPhaseEvent } from "./types";

// Interface for an ML provider – can be swapped out for a real model later
export interface IMLProvider {
  /**
   * Generate a list of candidate token arrays for the given brief.
   * The provider must return exactly three candidates representing the rough,
   * structural, and detailed phases.
   */
  generate(brief: DesignBriefV1, provenance: ProvenanceV1): Promise<string[][]>;
}

// Simple deterministic placeholder provider
class PlaceholderProvider implements IMLProvider {
  async generate(brief: DesignBriefV1, provenance: ProvenanceV1): Promise<string[][]> {
    // For determinism we base the tokens on the prompt hash and the phase name
    const base = provenance.promptHash;
    const phases = ["rough", "structure", "detail"] as const;
    return phases.map((phase) => {
      // token format: `${phase}-${base.slice(0, 8)}-token${i}`
      const tokenCount = phase === "detail" ? 5 : 3; // more tokens for detail
      const tokens: string[] = [];
      for (let i = 0; i < tokenCount; i++) {
        tokens.push(`${phase}-${base.slice(0, 8)}-t${i}`);
      }
      return tokens;
    });
  }
}

export class GenerationEngine extends EventEmitter {
  private provider: IMLProvider;

  constructor(provider?: IMLProvider) {
    super();
    this.provider = provider ?? new PlaceholderProvider();
  }

  /**
   * Run the generation pipeline for a design brief.
   * Emits RoughPhaseEvent → StructurePhaseEvent → DetailPhaseEvent sequentially.
   */
  async generate(brief: DesignBriefV1): Promise<void> {
    // Compute provenance fields that are deterministic
    const promptHash = createHash("sha256")
      .update(JSON.stringify(brief))
      .digest("hex");
    const seed = brief.seed ?? Number(`0x${promptHash.slice(0, 8)}`);
    const provenance: ProvenanceV1 = {
      model: "placeholder-ml",
      version: "0.1",
      promptHash,
      seed,
      timestamp: new Date().toISOString(),
    };

    const tokenLists = await this.provider.generate(brief, provenance);
    // tokenLists order corresponds to rough, structure, detail
    const phases = ["rough", "structure", "detail"] as const;
    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i];
      const tokens = tokenLists[i];
      const candidate: GenerationCandidateV1 = {
        id: `${phase}-${promptHash.slice(0, 8)}`,
        provenance,
        tokens,
        summary: `${phase} candidate generated from placeholder provider`,
      };
      const event = this.makePhaseEvent(phase, [candidate]);
      this.emit(phase, event);
    }
  }

  private makePhaseEvent(
    phase: "rough" | "structure" | "detail",
    candidates: GenerationCandidateV1[],
  ) {
    switch (phase) {
      case "rough":
        return RoughPhaseEvent.parse({ phase: "rough", candidates });
      case "structure":
        return StructurePhaseEvent.parse({ phase: "structure", candidates });
      case "detail":
        return DetailPhaseEvent.parse({ phase: "detail", candidates });
    }
  }
}
