import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

export interface LegalLayoutProps {
  eyebrow: string
  title: string
  effectiveDate: string
  children: ReactNode
}

/** Shared chrome for the standalone legal pages. Not a `StatePanel`: this is ordinary content, not a status. */
export function LegalLayout({ eyebrow, title, effectiveDate, children }: LegalLayoutProps) {
  return (
    <article className="pf-legal-page">
      <header className="pf-legal-page__header">
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p className="pf-legal-page__meta">Effective date: {effectiveDate}</p>
        <Link className="pf-legal-page__back" to="/">
          &larr; Back to Brickwright
        </Link>
      </header>
      <div className="pf-legal-page__notice" role="note">
        <p>
          <strong>This is not legal advice.</strong> This document was drafted from Brickwright&rsquo;s actual
          technical implementation as a starting point for launch, not by a lawyer. Every bracketed placeholder
          below &mdash; the operating entity, governing law, minimum age, and contact address &mdash; is a fact
          only Brickwright&rsquo;s operator can supply. Confirm those facts and have this whole document
          reviewed by a qualified lawyer before relying on it for legal compliance.
        </p>
      </div>
      <div className="pf-legal-page__body">{children}</div>
    </article>
  )
}

export default LegalLayout
