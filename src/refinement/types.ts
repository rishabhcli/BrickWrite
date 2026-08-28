// Refinement request and proposal types

import { Actor, CadOperation, ModelDocument, ValidationReport } from "../cad/types";

/**
 * A user‑originated request for the system to improve or modify a part of the model.
 * It is intentionally lightweight – additional fields can be added as the feature evolves.
 */
export interface RefinementRequestV1 {
  /** Unique identifier for the request */
  id: string;
  /** Actor who created the request */
  author: Actor;
  /** ISO timestamp of creation */
  createdAt: string;
  /** The document revision this request targets */
  baseRevision: number;
  /** Optional region or part identifier the request focuses on */
  targetRegion?: string;
  /** Human‑readable description of the desired change */
  description: string;
}

/**
 * A concrete proposal generated in response to a {@link RefinementRequestV1}.
 * Contains the operations needed to realise the refinement and a preview document.
 */
export interface RefinementProposalV1 {
  /** Unique identifier for the proposal */
  id: string;
  /** Identifier of the originating request */
  requestId: string;
  /** Actor (e.g., AI assistant) that generated the proposal */
  author: Actor;
  /** ISO timestamp of creation */
  createdAt: string;
  /** Operations that enact the refinement */
  operations: CadOperation[];
  /** Document preview after applying the operations */
  previewDocument: ModelDocument;
  /** Validation report for the preview */
  validation: ValidationReport;
  /** Current lifecycle state */
  status: "pending" | "applied" | "rejected";
}
