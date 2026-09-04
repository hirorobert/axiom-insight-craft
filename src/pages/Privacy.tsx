import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";

export default function Privacy() {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="max-w-3xl mx-auto px-6 pt-32 pb-20">
        <h1 className="text-3xl font-bold text-foreground mb-2">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground mb-10">Last updated: 4 September 2026</p>

        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 mb-10 text-sm text-muted-foreground">
          This page is a plain-language placeholder pending professional legal
          review. It describes current data handling practices as implemented in
          the service today, not a certified compliance posture (GDPR, ISO, SOC 2,
          or otherwise) — no such certification is claimed.
        </div>

        <section className="space-y-8 text-sm leading-relaxed text-muted-foreground">
          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">1. What we collect</h2>
            <p>
              Account information you provide (name, email, firm and company
              names), the trial balances and supporting documents you upload, the
              reconciliation, statement, tax, compliance, and filing data your firm
              produces while using the service, and basic technical logs needed to
              operate and secure the service.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">2. How it's stored</h2>
            <p>
              Data is stored in our hosted database and file storage, encrypted at
              rest, behind authentication and row-level access controls scoped to
              your firm's own companies and workspace members. Staff do not access
              your accounting data except as needed to operate, secure, or support
              the service, or to comply with the law.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">3. How it's used</h2>
            <p>
              To provide the service you signed up for: running the accounting,
              reconciliation, tax, and monitoring engines you invoke, maintaining
              your workspace state, and keeping an audit trail of professional
              decisions and administrative actions for your own firm's record. We
              do not sell your data, and we do not use your accounting data to
              train models for other customers.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">4. Commercial and billing data</h2>
            <p>
              Separately from your accounting data, we maintain minimal commercial
              records (plan, licence status, and — once introduced — payment
              history) needed to operate accounts and support. This commercial
              record is kept administratively separate from, and is never used to
              alter, your accounting data or the results your firm has produced.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">5. Retention and deletion</h2>
            <p>
              We retain your data for as long as your account is active, or as
              needed to meet legal, regulatory, or audit-trail obligations relevant
              to accounting records. Contact us to request deletion of an account
              you control, subject to any retention we're legally required to keep.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">6. Third parties</h2>
            <p>
              We use infrastructure providers (hosting, database, authentication)
              to run the service. We do not currently integrate a payment provider.
              When one is introduced, this policy will be updated to name it before
              it is used to process any payment.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">7. Contact</h2>
            <p>
              For questions about this policy or your data, contact the team
              through the channel provided at sign-up or by your account
              representative.
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
