
import type { CatalogSearchRecord, PartDefinition, CatalogTier } from '../../cad/types';

/**
 * Result of resolving a textual intent to a concrete part.
 */
export interface PartIntentResult {
  /** The best matching part definition, if any. */
  definition: PartDefinition | null;
  /** Confidence score between 0 and 1 (higher is better). */
  confidence: number;
  /** Human‑readable explanation of why this part was selected. */
  explanation: string;
  /** The catalog tier indicating the depth of knowledge we have about the part. */
  tier: CatalogTier;
  /** Whether compiled geometry is available for the part. */
  geometryAvailable: boolean;
  /** Alternate matching parts, ordered by decreasing relevance. */
  alternatives: PartDefinition[];
}

/**
 * Resolve a free‑form intent string to the most appropriate LEGO part.
 *
 * The function uses the existing catalog search infrastructure to rank parts
 * and then enriches the top match with additional metadata.
 *
 * @param intent   A user supplied description, e.g. "2 × 2 brick with knob".
 * @param maxResults Maximum number of alternatives to return (including the primary).
 * @returns        A {@link PartIntentResult} describing the best match and its alternatives.
 */
export async function resolvePartIntent(intent: string, maxResults = 5): Promise<PartIntentResult> {
  // Lazy-load catalog utilities only when this function runs.
  const { searchCatalog, getPartDefinition } = await import('../../cad/catalog');

  // Perform a catalog search – the underlying engine tokenises and ranks.
  const records: CatalogSearchRecord[] = searchCatalog({ text: intent });

  if (records.length === 0) {
    return {
      definition: null,
      confidence: 0,
      explanation: `No matching part found for "${intent}".`,
      tier: 'catalogued',
      geometryAvailable: false,
      alternatives: [],
    };
  }

  // Take the top N records.
  const top = records.slice(0, maxResults);

  // Helper to build an explanation from a record.
  const makeExplanation = (rec: CatalogSearchRecord) => {
    const size = rec.dimensions ? `${rec.dimensions[0]}×${rec.dimensions[1]}×${rec.dimensions[2]} studs` : 'unknown size';
    const geom = rec.geometryAvailable ? 'has compiled geometry' : 'no geometry available';
    return `${rec.name} (${rec.id}) – ${rec.category}, ${size}, ${geom}.`;
  };

  const primaryRecord = top[0];
  const primaryDef = getPartDefinition(primaryRecord.id) ?? null;

  // Simple confidence based on rank position – top result confidence 1.
  const confidence = 1;

  const alternatives = top.slice(1).map(r => getPartDefinition(r.id)).filter((d): d is PartDefinition => !!d);

  return {
    definition: primaryDef,
    confidence,
    explanation: makeExplanation(primaryRecord),
    tier: primaryRecord.tier,
    geometryAvailable: primaryRecord.geometryAvailable,
    alternatives,
  };
}
