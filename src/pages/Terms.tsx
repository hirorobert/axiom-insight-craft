import { Link } from "react-router-dom";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";

export default function Terms() {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="max-w-3xl mx-auto px-6 pt-32 pb-20">
        <h1 className="text-3xl font-bold text-foreground mb-2">Terms of Service</h1>
        <p className="text-sm text-muted-foreground mb-10">Last updated: 3 November 2026</p>

        <section className="space-y-8 text-sm leading-relaxed text-muted-foreground">
          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">1. What CFOClose is today</h2>
            <p>
              CFOClose is accounting-workflow software for audit and finance
              teams: trial balance preparation, bank reconciliation,
              financial statement drafting and analytical monitoring. It is a
              tool that assists a firm's own professionals — it does not replace
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
            <h2 className="text-lg font-semibold text-foreground mb-2">3. Current commercial terms</h2>
            <p>
              Access depends on the plan and permissions recorded for your
              account and company. Any purchase is subject to the price, currency,
              billing interval and cancellation or refund terms shown before you
              confirm payment. Connecting an accounting source does not itself
              authorize a purchase or change your plan.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">4. Your data</h2>
            <p>
              Trial balances, reconciliation evidence, statements and every other
              record you prepare with the service — including records created with
              services that are no longer offered — belong to you and your firm.
              We do not sell your data. See the <Link to="/privacy" className="underline hover:text-foreground">Privacy Policy</Link> for how it is
              handled.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">5. No warranty of statutory accuracy</h2>
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
            <h2 className="text-lg font-semibold text-foreground mb-2">6. Changes to these terms</h2>
            <p>
              We may update these terms as the service changes. Material changes
              will be reflected on this page with an updated date above.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">7. Contact</h2>
            <p>
              For support or questions about these terms, email{" "}
              <a href="mailto:support@cfoclose.com" className="underline hover:text-foreground">support@cfoclose.com</a>.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">8. QuickBooks connections and imports</h2>
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
            <h2 className="text-lg font-semibold text-foreground mb-2">9. Optional AI assistance</h2>
            <p>
              Customer-facing AI features are currently disabled or withheld
              server-side. Trial balance ingestion and financial calculations
              use deterministic code. Optional AI functionality exists for
              advisory explanations and drafting; it does not approve accounts,
              journals or reports. Before enabling external AI processing of
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
