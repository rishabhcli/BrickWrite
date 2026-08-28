// Minimal refinement pipeline implementation.
// The real engine will eventually analyse a request, generate proposals,
// run validation, and return a list of viable proposals.

import { RefinementRequestV1, RefinementProposalV1 } from "./types";
import { Actor, CadOperation, ModelDocument, ValidationReport } from "../cad/types";
import { generateId } from "../util/id"; // assume an existing helper, fallback if missing

/**
 * Placeholder function that pretends to generate proposals.
 * Currently returns an empty array – the UI can handle no proposals.
 */
export async function generateProposals(
  request: RefinementRequestV1,
  currentDocument: ModelDocument,
  author: Actor = { kind: "assistant" }
): Promise<RefinementProposalV1[]> {
  // In a full implementation we would:
  // 1. Analyse `request` and the current document.
  // 2. Produce one or more CadOperation arrays.
  // 3. Apply them to a copy of the document to create a preview.
  // 4. Run the existing validation pipeline.
  // 5. Return proposals with status "pending".

  // For now we return an empty list to keep the build happy.
  return [];
}

/**
 * Optional helper to create a minimal dummy proposal – useful for tests.
 */
export function createDummyProposal(
  requestId: string,
  document: ModelDocument,
  ops: CadOperation[] = [],
  validation: ValidationReport = { errors: [], warnings: [] }
): RefinementProposalV1 {
  return {
    id: generateId(),
    requestId,
    author: { kind: "assistant" },
    createdAt: new Date().toISOString(),
    operations: ops,
    previewDocument: document,
    validation,
    status: "pending",
  };
}
