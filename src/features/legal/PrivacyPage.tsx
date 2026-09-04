import { LegalLayout } from './LegalLayout'

export function PrivacyPage() {
  return (
    <LegalLayout eyebrow="LEGAL" title="Privacy Policy" effectiveDate="[DATE — fill in when you publish this]">
      <section>
        <h2>1. Overview</h2>
        <p>
          This Privacy Policy describes what Brickwright collects when you use the Service at brickwrite.tech,
          why, who it is shared with, and the choices you have. &ldquo;Brickwright&rdquo;, &ldquo;we&rdquo;, and
          &ldquo;us&rdquo; mean <strong>[OPERATOR / LEGAL ENTITY NAME &mdash; TO BE CONFIRMED]</strong>.
        </p>
      </section>

      <section>
        <h2>2. Information we collect</h2>
        <h3>Account information</h3>
        <p>
          If you create an account, our identity provider (Hexclave) handles authentication for you: your
          email address, and depending on the method you choose, an OAuth identity from Google or GitHub, or a
          registered passkey. We do not see or store your Google/GitHub password, and passkey/OAuth users have
          no separate Brickwright password at all.
        </p>
        <h3>Content you create</h3>
        <p>
          Projects you build while signed out live only in your browser&rsquo;s local storage (IndexedDB) and
          are never transmitted to us. If you sign in and save a cloud project, its data is stored so it can
          sync back to your other sessions.
        </p>
        <h3>Content you publish</h3>
        <p>
          If you create a share link or list a build in the public gallery, that specific snapshot becomes
          accessible to anyone with the link, or to the public, respectively &mdash; that is the point of
          publishing, and it is a deliberate action you take, not a default. See also the Terms of Service.
        </p>
        <h3>AI generation prompts</h3>
        <p>
          If you use the natural-language design or assistant features, the text you type and the resulting
          chat transcript are sent to a third-party AI provider (currently Anthropic) to produce or modify a
          build. The provider processes this text to generate a response; it is not used to identify you
          beyond the request itself.
        </p>
        <h3>Analytics and usage information</h3>
        <p>Brickwright uses two separate, intentionally different mechanisms for understanding how the Service is used:</p>
        <ul>
          <li>
            <strong>Opt-in tracking.</strong> Our identity/analytics provider (Hexclave) can record page views,
            clicks, and session replay (a recording of on-screen interaction) so we can see how the product is
            actually used. This does not run until you actively accept it via the cookie preferences control;
            declining or ignoring the prompt keeps it off, and you can change your choice at any time. Even
            when enabled, regions of the page that can hold your design content &mdash; project names, notes,
            design prompts, the assistant chat transcript, part-search queries, and share captions &mdash; are
            deliberately masked and excluded from what is recorded.
          </li>
          <li>
            <strong>Anonymous product analytics.</strong> Separately, Brickwright always records a small set of
            named product-usage events &mdash; for example, which button was clicked, which demo was viewed, or
            how long a page took to load. These events carry no cookie, no device or account identifier, and no
            IP address, and are not linked to your identity. Because they are anonymous and not
            &ldquo;tracking&rdquo; in any individually identifying sense, they are not gated behind the
            cookie-preferences choice above.
          </li>
        </ul>
        <p>We do not use advertising networks, and we do not use any of the above for cross-site tracking or retargeting.</p>
      </section>

      <section>
        <h2>3. Cookies</h2>
        <ul>
          <li><strong>Essential:</strong> a session cookie from our identity provider keeps you signed in. The Service cannot authenticate you without it.</li>
          <li><strong>Optional (consent-gated):</strong> if you accept the opt-in tracking described above, our identity/analytics provider sets a cookie to associate your page views, clicks, and replay data with a session.</li>
          <li><strong>None:</strong> the anonymous product-usage events described above are sent without any cookie or persistent identifier at all.</li>
        </ul>
      </section>

      <section>
        <h2>4. How we use information</h2>
        <p>We use the information above to:</p>
        <ul>
          <li>operate, maintain, and authenticate access to the Service;</li>
          <li>sync your cloud projects across your own sessions;</li>
          <li>generate or modify build content at your explicit request;</li>
          <li>understand, in aggregate, how the product is used, so we can improve it;</li>
          <li>secure the Service against abuse and enforce the Terms of Service; and</li>
          <li>respond to support or legal requests you or the law direct to us.</li>
        </ul>
      </section>

      <section>
        <h2>5. Who we share information with</h2>
        <p>We do not sell your personal information. We share it only with the service providers that run Brickwright, each processing only what its role requires:</p>
        <ul>
          <li><strong>Hexclave</strong> &mdash; authentication, transactional email (sign-in codes, invitations), and, if you opt in, analytics and session replay.</li>
          <li><strong>Cloudflare</strong> &mdash; hosts brickwrite.tech and provides edge storage used for share links and rate-limiting.</li>
          <li><strong>Vercel</strong> &mdash; runs the server-side process that talks to our identity provider and the AI provider.</li>
          <li><strong>Convex</strong> &mdash; stores cloud-synced project data for signed-in users.</li>
          <li><strong>Anthropic</strong> &mdash; receives the text of design prompts and assistant chat transcripts you submit, to generate or modify build content. It does not receive your full project file unless you include it in a prompt.</li>
        </ul>
        <p>We may also disclose information if required by law, or to protect the rights, safety, or property of Brickwright or our users.</p>
      </section>

      <section>
        <h2>6. Data retention</h2>
        <ul>
          <li>Local-only projects never leave your browser; clearing your browser storage deletes them.</li>
          <li>Account and cloud-project data is kept while your account exists, and deleted when you delete your account, [DESCRIBE ANY ADDITIONAL LOG-RETENTION WINDOW HERE — e.g. residual backups kept for N days].</li>
          <li>Published or shared content is kept until you unpublish or delete it.</li>
          <li>Opt-in analytics/replay data is retained by our identity/analytics provider under its own retention window.</li>
          <li>Anonymous product-usage events are kept in our own operational logs for [DESCRIBE ANY ADDITIONAL LOG-RETENTION WINDOW HERE].</li>
        </ul>
      </section>

      <section>
        <h2>7. Children&rsquo;s information</h2>
        <p>
          Brickwright is not directed at children under 13, and we do not knowingly collect personal
          information from them. If you believe a child has provided us with personal information, contact us
          using the details below and we will delete it.
        </p>
      </section>

      <section>
        <h2>8. Your rights</h2>
        <p>
          Depending on where you live, you may have the right to access, correct, delete, or export a copy of
          your personal information, to object to or restrict certain processing, and to withdraw the opt-in
          analytics consent described above at any time via the cookie preferences control. To exercise any of
          these, contact us at <strong>[CONTACT EMAIL &mdash; TO BE CONFIRMED]</strong>.
        </p>
      </section>

      <section>
        <h2>9. California privacy rights</h2>
        <p>
          If you are a California resident, you have the right to know what personal information we collect
          about you, to request its deletion or correction, and to opt out of its &ldquo;sale&rdquo; or
          &ldquo;sharing&rdquo; as those terms are defined under California law. We do not sell or share
          personal information for cross-context behavioral advertising, and have not done so in the preceding
          12 months. We will not discriminate against you for exercising these rights.
        </p>
      </section>

      <section>
        <h2>10. International data transfers</h2>
        <p>
          Our hosting providers and sub-processors operate in the United States. Using the Service means your
          information may be processed there, which may have different data protection laws than your own
          country.
        </p>
      </section>

      <section>
        <h2>11. Changes to this policy</h2>
        <p>
          We will update the effective date above whenever this policy changes, and, for material changes, make
          a reasonable effort to bring them to your attention.
        </p>
      </section>

      <section>
        <h2>12. Contact</h2>
        <p>
          <strong>[OPERATOR / LEGAL ENTITY NAME &mdash; TO BE CONFIRMED]</strong>
          <br />
          Email: <strong>[CONTACT EMAIL &mdash; TO BE CONFIRMED]</strong>
        </p>
      </section>
    </LegalLayout>
  )
}

export default PrivacyPage
