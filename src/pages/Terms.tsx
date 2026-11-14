import { Link } from "react-router-dom";
import { channel, mailtoHref } from "@/lib/contact/contactChannels";
import { REFUNDS_AND_CANCELLATION } from "@/lib/commercial/purchaseTerms";
import { BUSINESS_IDENTITY, telephoneLine } from "@/lib/commercial/businessIdentity";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { ArchivedPolicy, PolicyVersionLine, usePolicyVersion } from "@/components/legal/PolicyVersion";

// Sections 1-6 carry the settled text of the commercial package (sections 10.3 and 10.5; handoff Updates 4-6). Sections 9 and 10
// (limitation of liability, governing law) are the wording of dossier 28.2, approved in principle by the owner on 2026-11-14 and
// rendered here on the draft branch; publication waits for the owner's final contractual approval of the exact TERMS_VERSION.
// The QuickBooks and AI sections keep their existing text.
export default function Terms() {
  const version = usePolicyVersion();
  if (version.requested && (version.archived || version.unknown)) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <ArchivedPolicy page="terms" requested={version.requested} text={version.archived?.terms ?? null} unknown={version.unknown} />
        <Footer />
      </div>
    );
  }
  const telephone = telephoneLine();
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="max-w-3xl mx-auto px-6 pt-32 pb-20">
        <h1 className="text-3xl font-bold text-foreground mb-2">Terms of Service</h1>
        <PolicyVersionLine page="terms" />

        <section className="space-y-8 text-sm leading-relaxed text-muted-foreground">
          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">1. Who we are</h2>
            <p data-testid="terms-identity">
              {BUSINESS_IDENTITY.termsIdentity}
              {telephone ? ` ${telephone}` : null}
              {" "}E-mail: <a href={mailtoHref("support")} className="underline hover:text-foreground">{channel("support").address}</a>;
              legal notices: <a href={mailtoHref("contact")} className="underline hover:text-foreground">{channel("contact").address}</a>.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">2. Who sells your plan</h2>
            <p data-testid="terms-seller">
              Plans are sold by our reseller and merchant of record, Polar Software, Inc. Polar takes your payment on its
              own page, adds any sales tax or VAT that applies to your location, shows the total before you pay and issues your
              receipt, under the{" "}
              <a href="https://polar.sh/legal/checkout-buyer-terms" className="underline hover:text-foreground">Polar Checkout Buyer Terms</a>{" "}
              (https://polar.sh/legal/checkout-buyer-terms). Your card details never reach us. We provide the service you
              buy, under these Terms.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">3. What CFOClose is today</h2>
            <p>
              CFOClose is accounting-workflow software for audit and finance teams. The service available to customers today is trial balance review: upload and validate a trial balance, review and confirm its account classifications, and reach a reviewed trial balance ready for statement preparation. Each review decision is recorded against the signed-in user who made it. A workspace whose filing jurisdiction has a jurisdiction pack may also show that jurisdiction's own record-keeping panel.
            </p>
            <p className="mt-3">
              Financial reporting is a pilot by invitation: it is offered only to companies we have invited, it is not generally available, and its accounting has not been independently validated. QuickBooks connections are not currently available; they await Intuit's production authorisation. AI features are disabled. Other parts of the software are not available to customers.
            </p>
            <p className="mt-3">
              CFOClose assists your firm's own professionals. It does not provide an audit, an audit opinion, assurance,
              or legal or other professional advice, and it does not guarantee that any trial balance, classification or statement
              is complete, accurate or compliant. You remain responsible for your professional judgement and for what you
              sign.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">4. Accounts and access</h2>
            <p>
              You need an account to use the service. You are responsible for the
              accuracy of information you submit and for restricting access to your
              account and your firm's workspace to people you have authorized.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">5. Plans, price and term</h2>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                Plans: Solo (1 active entity), Practice (5) and Firm (25), each with unlimited team members, at the prices
                on our <Link to="/plans" className="underline hover:text-foreground">plans page</Link> (currently USD 490,
                990 and 2,990 a year), excluding any sales tax or VAT. Enterprise is agreed by contract.
              </li>
              <li>Term: each plan is a one-time payment for a 12-month term and does not renew automatically. Nothing is charged again unless you buy a new term.</li>
              <li>Start: a plan starts when Polar has confirmed the payment to us, not when you return from the payment page.</li>
              <li>Upgrades: an upgrade starts when its payment is confirmed and ends the current plan at that moment.</li>
              <li>End of term: when a term ends, nothing is deleted. The account holder can still read work already prepared, and actions that need a current plan stop until a new term is bought. The end date is shown in your billing settings.</li>
            </ul>
          </div>

          <div>
            <h2 id={REFUNDS_AND_CANCELLATION.anchor} className="text-lg font-semibold text-foreground mb-2">6. {REFUNDS_AND_CANCELLATION.heading}</h2>
            <p className="whitespace-pre-line" data-testid="terms-refunds">{REFUNDS_AND_CANCELLATION.text}</p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">7. Your data</h2>
            <p>
              Trial balances, supporting documents, review decisions and every
              other record you prepare with the service — including records created with
              services that are no longer offered — belong to you and your firm.
              We do not sell your data. See the <Link to="/privacy" className="underline hover:text-foreground">Privacy Policy</Link> for how it is
              handled.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">8. No warranty of statutory accuracy</h2>
            <p>
              Accounting rules applied by the service are updated on a
              best-effort basis. The service does not warrant that every
              computation is free of error or that it reflects the most recent
              regulatory change at all times. A qualified professional must review
              outputs before they are relied upon, filed, or submitted to any
              authority.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">9. Limitation of liability</h2>
            <p data-testid="terms-liability">
              To the extent the law allows, our total liability to you for any claim arising from the service in any 12-month
              period is limited to the amount you paid for your plan for that period. We are not liable for indirect or
              consequential loss, or for decisions you make using information from the service; you remain responsible for
              your professional judgement and for what you sign. Nothing in these Terms limits liability that cannot be limited
              by law.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">10. Governing law and disputes</h2>
            <p data-testid="terms-law">
              These Terms are governed by the laws of the United Republic of Tanzania, and the courts of Tanzania have
              jurisdiction over disputes about the service. This does not affect your rights under mandatory consumer law, or
              the Polar Checkout Buyer Terms that govern your purchase contract with Polar.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">11. Changes to these terms</h2>
            <p>
              We may update these terms as the service changes. Material changes
              will be reflected on this page with an updated version above.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">12. Contact</h2>
            <p>
              Support: <a href={mailtoHref("support")} className="underline hover:text-foreground">{channel("support").address}</a>.
              Billing and refunds: <a href={mailtoHref("billing")} className="underline hover:text-foreground">{channel("billing").address}</a>.
              Legal notices: <a href={mailtoHref("contact")} className="underline hover:text-foreground">{channel("contact").address}</a>.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">13. QuickBooks connections and imports</h2>
            <p>
              Customer QuickBooks connections are not currently available. The
              integration is being tested with Intuit sandbox companies. When
              available, only connect books you are authorized to access.
              Authorization takes place at Intuit; CFOClose does not collect your
              Intuit password. Intuit grants an accounting scope that is broader
              than read-only access. CFOClose restricts its connector to reading
              the trial balance and fiscal preferences, together with the token
              operations needed to connect, refresh access and disconnect. It
              does not write accounting transactions back to QuickBooks.
            </p>
            <p className="mt-3">
              An import is a snapshot, not continuous synchronization. Review its
              company, reporting period, accounting basis, currency, balances and
              classifications before relying on it. QuickBooks trial balances
              use fiscal year-to-date semantics; the connector checks fiscal
              settings against your confirmed reporting dates. Disconnecting
              stops new imports and requests revocation of access. Saved imports
              and reports remain in your workspace; disconnection is not a
              deletion request. An unconfirmed revocation must not be treated
              as completed.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">14. Optional AI assistance</h2>
            <p>
              Customer-facing AI features are currently disabled or withheld
              server-side. Trial balance ingestion and financial calculations
              use deterministic code. Optional AI functionality in the code is
              advisory only; it does not approve accounts, journals or reports. Before enabling external AI processing of
              accounting data, we require a review of provider data-handling
              terms, appropriate disclosures and authorization controls.
              Availability of AI in development tools does not make it an
              enabled customer feature.
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
