import { Link } from "react-router-dom";
import { channel, mailtoHref } from "@/lib/contact/contactChannels";
import { REFUNDS_AND_CANCELLATION } from "@/lib/commercial/purchaseTerms";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";

export default function Terms() {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="max-w-3xl mx-auto px-6 pt-32 pb-20">
        <h1 className="text-3xl font-bold text-foreground mb-2">Terms of Service</h1>
        <p className="text-sm text-muted-foreground mb-10">Last updated: 11 November 2026</p>

        <section className="space-y-8 text-sm leading-relaxed text-muted-foreground">
          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">1. What CFOClose is today</h2>
            <p>
              CFOClose is accounting-workflow software for audit and finance
              teams. The service available to customers today is trial balance
              review: upload and validate a trial balance, review and confirm
              its account classifications, and reach a reviewed trial balance
              ready for statement preparation. Each review decision is recorded
              against the signed-in user who made it. A workspace whose filing
              jurisdiction has a jurisdiction pack may also show that
              jurisdiction's own record-keeping panel.
            </p>
            <p className="mt-3">
              Financial reporting is a pilot by invitation: it is offered only
              to companies we have invited, it is not generally available, and
              its accounting has not been independently validated. Other parts
              of the software are not available to customers.
            </p>
            <p className="mt-3">
              CFOClose assists a firm's own professionals — it does not replace
              professional judgment, and it is not itself a licensed audit or
              accounting firm.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">2. Accounts and access</h2>
            <p>
              You need an account to use the service. You are responsible for the
              accuracy of information you submit and for restricting access to your
              account and your firm's workspace to people you have authorized.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">3. Plans, payment and term</h2>
            <p>
              Plans and their prices are listed on the{" "}
              <Link to="/plans" className="underline hover:text-foreground">plans page</Link>. Each plan is
              bought by a one-time card payment for a 12-month term. A plan
              does not renew automatically: nothing is charged again unless you
              buy a new term.
            </p>
            <p className="mt-3">
              Card payments are processed by Polar, acting as merchant of
              record: Polar takes the payment on its own secure page, adds any
              sales tax that applies to your location and shows the total before
              you pay. Your card details never reach CFOClose. Polar's own terms
              apply to the payment.
            </p>
            <p className="mt-3">
              A plan starts only when the payment has been verified with Polar,
              not when you return from the payment page. An upgrade starts when
              its payment is verified and ends your current plan at that moment;
              unused time on the current plan is not refunded automatically, and
              you can contact us to have it credited. Connecting an accounting
              source does not itself authorize a purchase or change your plan.
            </p>
            <p className="mt-3">
              When a term ends, the plan ends. Nothing is deleted: the account
              holder can still read the work already prepared, while team
              members' access and actions that need a current plan, such as
              adding an entity, stop until a new term is bought. The end date is
              shown in your billing settings; we do not currently send a
              reminder before a term ends.
            </p>
          </div>

          <div>
            <h2 id={REFUNDS_AND_CANCELLATION.anchor} className="text-lg font-semibold text-foreground mb-2">4. {REFUNDS_AND_CANCELLATION.heading}</h2>
            <p data-testid="terms-refunds">{REFUNDS_AND_CANCELLATION.text}</p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">5. Your data</h2>
            <p>
              Trial balances, supporting documents, review decisions and every
              other record you prepare with the service — including records created with
              services that are no longer offered — belong to you and your firm.
              We do not sell your data. See the <Link to="/privacy" className="underline hover:text-foreground">Privacy Policy</Link> for how it is
              handled.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">6. No warranty of statutory accuracy</h2>
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
            <h2 className="text-lg font-semibold text-foreground mb-2">7. Changes to these terms</h2>
            <p>
              We may update these terms as the service changes. Material changes
              will be reflected on this page with an updated date above.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">8. Contact</h2>
            <p>
              For support or questions about these terms, email{" "}
              <a href={mailtoHref("support")} className="underline hover:text-foreground">{channel("support").address}</a>.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">9. QuickBooks connections and imports</h2>
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
            <h2 className="text-lg font-semibold text-foreground mb-2">10. Optional AI assistance</h2>
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
