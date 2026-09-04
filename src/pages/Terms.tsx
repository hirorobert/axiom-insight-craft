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

        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 mb-10 text-sm text-muted-foreground">
          This page is a plain-language placeholder pending professional legal review.
          It describes the service as it exists today. It is not a substitute for
          advice from a qualified lawyer, and it will be replaced with reviewed
          legal terms before any paid subscription is offered.
        </div>

        <section className="space-y-8 text-sm leading-relaxed text-muted-foreground">
          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">1. What SAFF ERP is today</h2>
            <p>
              SAFF ERP is accounting-workflow software for Tanzania-focused audit and
              tax engagements: trial balance preparation, bank reconciliation,
              financial statement drafting, tax computation support, compliance
              review, filing pack preparation, and monitoring. It is a tool that
              assists a firm's own professionals — it does not replace professional
              judgment, and it is not itself a licensed audit, tax, or accounting
              firm.
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
              Tanzania tax and accounting rules referenced by the service (ITA
              Cap.332, Finance Act updates, IPSAS/IFRS for SMEs, TRA requirements)
              are applied on a best-effort basis and kept current as practically
              possible. The service does not warrant that every computation is free
              of error or that it reflects the very latest regulatory change at all
              times. A qualified professional must review outputs before they are
              relied upon or filed.
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
