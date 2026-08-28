import { describeSize } from '../../cad/catalog'
import type { PartQuery } from './query'
import type { RankedCandidate } from './rank'
import type { IdentityKind } from './lexical'

/**
 * One line saying why this part came back.
 *
 * The audience is a builder or an agent deciding whether to act, so the
 * explanation names the evidence that actually fired and nothing else. A
 * generic "best match for your query" would be worse than silence: it reads as
 * a reason while carrying none, and it hides the case the caller most needs to
 * catch, which is a high rank produced by a weak signal.
 */

const IDENTIFIER_LABEL: Record<IdentityKind, string> = {
  canonical: 'part number',
  ldraw: 'LDraw file number',
  retired: 'retired part number, now',
  rebrickable: 'Rebrickable number',
  design: 'LEGO design id',
  element: 'LEGO element id',
  bricklink: 'BrickLink number',
}

const TIER_CAVEAT: Record<string, string> = {
  modelled: 'LDraw models it but this build carries no mesh, so it cannot be placed',
  catalogued: 'catalogued only: the wider LEGO catalogue records it and nothing else is known',
}

export interface ExplainContext {
  /** False when the latent index was not resident, so no semantic evidence exists. */
  semanticResident: boolean
}

export function explainMatch(candidate: RankedCandidate, query: PartQuery, context: ExplainContext): string {
  const { document, detail } = candidate
  const clauses: string[] = []

  if (detail.exactIdKind) {
    clauses.push(`${IDENTIFIER_LABEL[detail.exactIdKind]} ${document.id}`)
  }

  if (detail.relation) {
    clauses.push(detail.relation.detail)
  }

  if (detail.lexical > 0.02 && query.contentTerms.length) {
    const terms = query.contentTerms.slice(0, 3).join(', ')
    clauses.push(
      detail.lexical >= 0.6 ? `name and category match "${terms}"` : `partial name match on "${terms}"`,
    )
  }

  if (detail.dimensional.score > 0) {
    const size = detail.dimensional.basis === 'measured' ? describeSize(measured(document)) : document.name
    clauses.push(
      detail.dimensional.basis === 'measured'
        ? `measured envelope ${size}`
        : `the name states the size the request asked for`,
    )
  } else if (!detail.dimensional.satisfied && detail.dimensional.basis === 'measured') {
    clauses.push(`measured ${describeSize(measured(document))}, which is not the size asked for`)
  } else if (query.dimensions.evidence.length && detail.dimensional.basis === null) {
    clauses.push('no compiled envelope, so the size could not be checked')
  }

  if (detail.connector.matched.length) {
    clauses.push(`carries ${detail.connector.matched.join(' and ')} connections`)
  }
  if (detail.connector.missing.length && detail.connector.testable) {
    clauses.push(`no ${detail.connector.missing.join(' or ')} connection recorded`)
  }

  if (query.color.codes.length) {
    if (detail.color.satisfied) clauses.push(`produced in ${colorPhrase(query)}`)
    else if (!detail.color.testable) clauses.push(`no colour evidence in this build, so ${colorPhrase(query)} is unverified`)
    else clauses.push(`never observed in ${colorPhrase(query)}`)
  }

  if (detail.semantic >= 0.45) {
    clauses.push(`latent similarity ${detail.semantic.toFixed(2)}`)
  } else if (!context.semanticResident && !detail.exactIdKind) {
    clauses.push('semantic index not resident, so this is a lexical match only')
  }

  clauses.push(
    document.frequency > 0
      ? `appears in ${document.frequency.toLocaleString('en-US')} official set inventories`
      : 'no recorded official-set appearance',
  )

  const caveat = TIER_CAVEAT[document.tier]
  if (caveat) clauses.push(caveat)

  const sentence = clauses.join('; ')
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`
}

/**
 * `describeSize` reads a `PartDefinition`, and the corpus keeps only the stud
 * triple, so the shape it needs is reconstructed rather than the whole record
 * being carried around for one label.
 */
function measured(document: RankedCandidate['document']) {
  if (!document.studs) return undefined
  return { dimensions: { studs: document.studs } } as Parameters<typeof describeSize>[0]
}

function colorPhrase(query: PartQuery): string {
  if (query.color.names.length) return query.color.names.slice(0, 2).join(' or ')
  if (query.color.finishes.length) return `a ${query.color.finishes[0]} finish`
  return 'the requested colour'
}
