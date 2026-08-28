import React from "react";
import { RefinementProposalV1 } from "./types";

/** Simple placeholder UI for displaying a refinement proposal. */
export function RefinementPanel({ proposal }: { proposal: RefinementProposalV1 }) {
  return (
    <div style={{ padding: "8px", border: "1px solid #ccc", borderRadius: "4px" }}>
      <h3 style={{ margin: 0, fontSize: "1.1rem" }}>Refinement Proposal</h3>
      <p>Proposal ID: {proposal.id}</p>
      <p>Status: {proposal.status}</p>
    </div>
  );
}
