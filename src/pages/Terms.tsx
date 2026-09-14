import { Link } from "react-router-dom";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";

export default function Terms() {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="max-w-3xl mx-auto px-6 pt-32 pb-20">
        <h1 className="text-3xl font-bold text-foreground mb-2">Terms of Service</h1>
        <p className="text-sm text-muted-foreground mb-10">Last updated: 4 September 2026</p>

        <section className="space-y-8 text-sm leading-relaxed text-muted-foreground">
          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">1. What CFOClose is today</h2>
            <p>
              CFOClose is accounting-workflow software for audit and finance
              teams: trial balance preparation, bank reconciliation,
              financial statement drafting, tax computation support, compliance
              review, filing pack preparation, and analytical monitoring. It is a
              tool that assists a firm's own professionals — it does not replace
              professional judgment, and it is not itself a licensed audit, tax, or
              accounting firm. Jurisdiction-specific compliance capabilities
              (including statutory tax computation and regulatory filing packs) are
              available as configuration packs and apply only when explicitly
              enabled for an engagement.
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
              Self-service paid subscriptions are not yet available. Sign-up
              currently provisions a free-tier workspace. If and when paid
              licensing becomes self-serve, these terms will be updated first, and
              nothing will be charged without that update being published and, where
              required, your affirmative agreement to it.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">4. Your data</h2>
            <p>
              Trial balances, reconciliation evidence, and the statements, tax
              computations, and filings you prepare belong to you and your firm.
              We do not sell your data. See the <Link to="/privacy" className="underline hover:text-foreground">Privacy Policy</Link> for how it is
              handled.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">5. No warranty of statutory accuracy</h2>
            <p>
              Accounting and tax rules applied by the service are updated on a
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
              For questions about these terms, contact the team through the channel
              provided at sign-up or by your account representative.
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
