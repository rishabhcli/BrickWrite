import { LegalLayout } from './LegalLayout'

export function TermsPage() {
  return (
    <LegalLayout eyebrow="LEGAL" title="Terms of Service" effectiveDate="[DATE — fill in when you publish this]">
      <section>
        <h2>1. Acceptance of these Terms</h2>
        <p>
          These Terms of Service (&ldquo;Terms&rdquo;) govern your access to and use of Brickwright, the
          browser-based LEGO<sup>&reg;</sup>-compatible brick CAD tool available at brickwrite.tech (the
          &ldquo;Service&rdquo;), operated by <strong>[OPERATOR / LEGAL ENTITY NAME &mdash; TO BE
          CONFIRMED]</strong> (&ldquo;Brickwright&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;). By creating an
          account, opening a document, or otherwise using the Service, you agree to these Terms. If you do not
          agree, do not use the Service.
        </p>
        <p>
          These Terms cover your use of the <em>hosted, running</em> Service. They are separate from the
          license on Brickwright&rsquo;s source code, covered below under &ldquo;Open-source code&rdquo;.
        </p>
      </section>

      <section>
        <h2>2. What Brickwright is</h2>
        <p>
          Brickwright lets you design brick-built models in your browser against a compiled catalog of LDraw
          part geometry. Documents can be created and edited entirely locally, generated or modified with an AI
          assistant, saved to a cloud project when you are signed in, and optionally published as a shareable
          link or listed in the public gallery. Not every feature described here is guaranteed to be available
          at all times or in every build.
        </p>
      </section>

      <section>
        <h2>3. Accounts and eligibility</h2>
        <p>
          Some features &mdash; cloud projects, publishing, and collaboration &mdash; require an account.
          Accounts are authenticated through our identity provider using Google sign-in, GitHub sign-in, an
          email address and password, an emailed one-time code, or a passkey. You are responsible for keeping
          your credentials and any device with an active session secure, and for everything that happens under
          your account.
        </p>
        <p>
          You must be at least <strong>[CONFIRM MINIMUM AGE &mdash; 13 assumed, consistent with the U.S. COPPA
          baseline]</strong> years old to create an account. If we learn someone below that age has given us
          personal information, we will delete it. See &ldquo;Children&rsquo;s information&rdquo; in the
          Privacy Policy.
        </p>
      </section>

      <section>
        <h2>4. Your content and what you publish</h2>
        <p>
          You own the models and projects you create in Brickwright. When you are signed out, your projects
          exist only in your browser&rsquo;s local storage and are never sent to us. When you are signed in and
          save a cloud project, we store it so it can sync back to you.
        </p>
        <p>
          When you explicitly publish a build &mdash; by creating a share link or listing it in the public
          gallery &mdash; you are choosing to make that specific, immutable snapshot visible to anyone with the
          link, or to the public, respectively. You grant us the limited license needed to host, store,
          transmit, and display that published snapshot for as long as you keep it published. We do not claim
          ownership of your designs, and we do not use unpublished, private, or local-only projects for
          anything beyond providing the Service to you.
        </p>
        <p>You are responsible for what you publish. Do not publish content that infringes someone else&rsquo;s rights or that you do not have the right to share.</p>
      </section>

      <section>
        <h2>5. Acceptable use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>use the Service for anything unlawful, or to store or publish unlawful content;</li>
          <li>
            abuse the AI-assisted generation feature &mdash; for example by sending prompts designed to extract
            another user&rsquo;s data, attempting to exceed rate or usage limits, or using it for anything
            unrelated to designing brick models;
          </li>
          <li>attempt to gain unauthorized access to another user&rsquo;s account, project, or data;</li>
          <li>
            interfere with, overload, or attempt to circumvent the security, rate-limiting, or metering
            controls that keep the Service available to everyone; or
          </li>
          <li>
            reverse engineer the hosted Service to bypass these Terms. Self-hosting your own instance of the
            open-source code under its own license is not covered by this restriction.
          </li>
        </ul>
      </section>

      <section>
        <h2>6. The AI generation feature</h2>
        <p>
          When you describe a build in natural language or use the assistant to modify a document, your prompt
          and the resulting conversation are sent to a third-party AI provider (currently Anthropic) for
          processing, as described in the Privacy Policy. Generated results are a starting point, not a
          guarantee: review anything the assistant produces before you rely on it.
        </p>
      </section>

      <section>
        <h2>7. Intellectual property</h2>
        <p>
          The Brickwright name, brand, and the parts of the Service that are not your content or open-source
          code (the compiled catalog pipeline, hosted infrastructure, marketing pages) belong to us or our
          licensors.
        </p>
        <h3>Open-source code</h3>
        <p>
          Brickwright&rsquo;s source code is published under the GNU Affero General Public License v3.0
          (AGPL-3.0). That license governs your rights to copy, modify, and self-host the code &mdash;
          including the &ldquo;network use&rdquo; obligations AGPL-3.0 imposes on a modified version you run as
          a service for others. It is a separate matter from these Terms, which govern your use of the copy of
          the Service we operate at brickwrite.tech.
        </p>
        <h3>LEGO and LDraw</h3>
        <p>
          LEGO<sup>&reg;</sup> is a trademark of the LEGO Group, which does not sponsor, endorse, or authorize
          LDraw or Brickwright. Brickwright uses the LDraw open standard and community-compiled part geometry to
          represent brick-built models; it is an independent, fan-made tool with no affiliation to the LEGO
          Group.
        </p>
      </section>

      <section>
        <h2>8. Third-party services</h2>
        <p>
          The Service relies on third-party providers for authentication, hosting, storage, email, and AI
          generation. Their processing of your information is described in the Privacy Policy. Using features
          that route through those providers is also subject to this section, but does not create a separate
          contract between you and them on our behalf.
        </p>
      </section>

      <section>
        <h2>9. Disclaimers</h2>
        <p>
          THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE,&rdquo; WITHOUT WARRANTIES OF ANY
          KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
          PARTICULAR PURPOSE, OR NON-INFRINGEMENT. We do not warrant that the Service will be uninterrupted,
          error-free, or that AI-generated content will be accurate, safe to build, or fit for any purpose.
        </p>
      </section>

      <section>
        <h2>10. Limitation of liability</h2>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, BRICKWRIGHT AND ITS OPERATOR WILL NOT BE LIABLE FOR ANY
          INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF DATA, ARISING FROM
          YOUR USE OF THE SERVICE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. Nothing in these Terms
          limits liability that cannot be limited under applicable law.
        </p>
      </section>

      <section>
        <h2>11. Termination</h2>
        <p>
          You may stop using the Service and delete your account at any time. We may suspend or terminate
          access to the Service, for you or generally, for conduct that violates these Terms or for operational
          reasons such as discontinuing the Service. Sections that by their nature should survive termination
          (intellectual property, disclaimers, limitation of liability) will survive.
        </p>
      </section>

      <section>
        <h2>12. Changes to the Service or these Terms</h2>
        <p>
          We may change or discontinue features of the Service, and may update these Terms as it changes
          &mdash; for example, if paid features are introduced later, these Terms and a separate billing
          disclosure would be updated to cover them first. We will update the effective date above when we do.
          Continued use of the Service after an update means you accept the revised Terms.
        </p>
      </section>

      <section>
        <h2>13. Governing law</h2>
        <p>
          These Terms are governed by the laws of <strong>[GOVERNING LAW / JURISDICTION &mdash; TO BE
          CONFIRMED]</strong>, without regard to conflict-of-law principles.
        </p>
      </section>

      <section>
        <h2>14. Contact</h2>
        <p>Questions about these Terms can be sent to <strong>[CONTACT EMAIL &mdash; TO BE CONFIRMED]</strong>.</p>
      </section>
    </LegalLayout>
  )
}

export default TermsPage
