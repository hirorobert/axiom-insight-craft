import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";

export default function Privacy() {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="max-w-3xl mx-auto px-6 pt-32 pb-20">
        <h1 className="text-3xl font-bold text-foreground mb-2">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground mb-10">Last updated: 3 November 2026</p>

        <section className="space-y-8 text-sm leading-relaxed text-muted-foreground">
          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">1. What we collect</h2>
            <p>
              Account information you provide (name, email, firm and company
              names), the trial balances and supporting documents you upload, the
              reconciliation, statement and other engagement records your firm
              produces while using the service (including records created with
              services that are no longer offered), and basic technical logs needed to
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
              the service, or to comply with the law. These are the practices we
              follow; we do not claim a certified compliance posture (such as
              GDPR, ISO 27001, or SOC 2) unless and until we hold that
              certification.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">3. How it's used</h2>
            <p>
              To provide the service you signed up for: running the accounting,
              reconciliation and monitoring engines you invoke, maintaining
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
              records (plan, licence status and, where applicable, payment
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
              Lovable Cloud and Supabase provide hosting, database, file
              storage, authentication and server-function infrastructure.
              Authorized workspace members can access the company records their
              permissions allow. Operational staff access is limited to service,
              security, support and legal needs. Intuit processes authorization
              and source requests for QuickBooks connections. Payment integrations
              in the product include Polar and Snippe; their availability depends
              on the configured checkout. Any payment provider and applicable
              terms must be shown before you confirm a payment.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">7. Contact</h2>
            <p>
              For privacy questions, access or deletion requests, or support,
              email{" "}
              <a href="mailto:support@cfoclose.com" className="underline hover:text-foreground">support@cfoclose.com</a>.
              We may need to verify your authority over an account or workspace
              before disclosing, changing or deleting its records.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">8. QuickBooks data</h2>
            <p>
              Customer QuickBooks access is currently disabled; sandbox testing
              uses Intuit sample companies. A connection records the source
              company identifier, environment, connection status and the person
              who connected it. Refresh tokens are encrypted on the server and
              are not exposed to workspace browsers. On an authorized import,
              the connector reads the trial balance and fiscal preferences.
              Saved records include account names and balances, period, currency,
              accounting basis, import time and integrity fingerprints.
              CFOClose does not collect your Intuit password or write accounting
              transactions back to QuickBooks.
            </p>
            <p className="mt-3">
              Disconnecting stops new imports and requests token revocation.
              It does not delete previously imported accounting records or
              reports. You can request deletion through the contact above,
              subject to applicable legal and audit-record retention obligations.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">9. AI processing</h2>
            <p>
              Customer-facing AI features are currently disabled or withheld by
              server controls. The code includes optional Anthropic and Lovable
              AI Gateway integrations, including Google Gemini. These are
              separate from the development tools used to build CFOClose.
              Deterministic trial balance ingestion does not call a model.
              Disabled runtime AI features do not dispatch accounting data to a
              model provider.
            </p>
            <p className="mt-3">
              We do not use your accounting data to train models for other
              customers. We have not verified a provider-wide zero-retention
              or no-training commitment for every optional integration and do
              not represent that we hold one. Before enabling processing of
              accounting data by an external model, we require review of the
              applicable provider terms, retention and training settings,
              updated disclosures and appropriate authorization controls.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">10. Hosting and international processing</h2>
            <p>
              The production database is configured in AWS eu-west-1, Ireland.
              Supabase states that project database, authentication, storage
              objects and backups are hosted in the selected project region.
              Edge Functions use distributed execution; content delivery,
              support and operational processing can involve other locations.
              We do not promise that all processing is confined to Ireland,
              the European Union or your country. Any future external AI
              processing requires the review described above.
            </p>
            <p className="mt-3">
              <a href="https://supabase.com/legal/privacy-resources/data-residency-and-transfers-faq" className="underline hover:text-foreground">Supabase data residency and transfers</a>
              {" "}describes the provider's regional hosting and international
              processing practices. This is provider documentation, not a
              claim that CFOClose holds a particular certification.
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
