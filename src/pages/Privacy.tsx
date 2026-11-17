import { channel, mailtoHref } from "@/lib/contact/contactChannels";
import { BUSINESS_IDENTITY } from "@/lib/commercial/businessIdentity";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { ArchivedPolicy, PolicyVersionLine, usePolicyVersion } from "@/components/legal/PolicyVersion";

export default function Privacy() {
  const version = usePolicyVersion();
  if (version.requested && (version.archived || version.unknown)) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <ArchivedPolicy page="privacy" requested={version.requested} text={version.archived?.privacy ?? null} unknown={version.unknown} />
        <Footer />
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="max-w-3xl mx-auto px-6 pt-32 pb-20">
        <h1 className="text-3xl font-bold text-foreground mb-2">Privacy Policy</h1>
        <PolicyVersionLine page="privacy" />

        <section className="space-y-8 text-sm leading-relaxed text-muted-foreground">
          <p data-testid="privacy-controller">{BUSINESS_IDENTITY.privacyController}</p>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">1. What we collect</h2>
            <p>
              Account information you provide (name, email, firm and company
              names), the trial balances and supporting documents you upload, the
              review decisions, reports and other engagement records your firm
              produces while using the service (including records created with
              services that are no longer offered), commercial records needed to
              operate your plan (see section 4), and basic technical logs needed
              to operate and secure the service.
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
              To provide the service you signed up for: checking and reviewing
              the trial balances you upload and recording your review decisions
              (and, for a company invited to the financial reporting pilot,
              preparing its reports), maintaining your workspace state, and
              keeping an audit trail of professional decisions and administrative
              actions for your own firm's record. We
              do not sell your data, and we do not use your accounting data to
              train models for other customers.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">4. Commercial and billing data</h2>
            <p>
              Separately from your accounting data, we maintain minimal commercial
              records (plan, licence status and, where applicable, payment
              history and provider payment references — never card numbers)
              needed to operate accounts and support. This commercial
              record is kept administratively separate from, and is never used to
              alter, your accounting data or the results your firm has produced.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">5. Retention and deletion</h2>
            <p data-testid="privacy-retention">
              We keep your account and workspace data while your account is active. You can ask us to delete or export
              your data by writing to <a href={mailtoHref("support")} className="underline hover:text-foreground">{channel("support").address}</a>;
              we first confirm your authority over the account. After a verified deletion request we delete or anonymise
              your personal data, except records the law requires us to keep (such as payment and billing records) and
              records of signed work where the law or a professional body requires them. Backups held by our hosting
              provider expire on its backup schedule.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">6. Third parties</h2>
            <p>
              Authorized workspace members can access the company records their
              permissions allow. Operational staff access is limited to service,
              security, support and legal needs. These external parties receive
              personal or financial data when you use the parts of the service
              named:
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-5" data-testid="privacy-third-parties">
              <li><strong className="text-foreground">Supabase</strong> - database, sign-in, file storage and
                server functions: all the data described in section 1.</li>
              <li><strong className="text-foreground">Lovable</strong> - site hosting, and the service's
                transactional e-mail (sign-up confirmation, password reset, invitations and enquiry
                acknowledgements), delivered through Mailgun: the recipient's e-mail address and the message.</li>
              <li><strong className="text-foreground">Google</strong> - only if you choose
                &ldquo;Continue with Google&rdquo;: you sign in at Google, and your name and e-mail address are passed
                to CFOClose; and the fonts the site loads from Google, which receives your browser's IP address and
                browser details when a page loads.</li>
              <li><strong className="text-foreground">Cloudflare Turnstile</strong> - a bot check on the
                public contact form: signals from your browser needed for the check.</li>
              <li><strong className="text-foreground">Namecheap Private Email</strong> - hosts the cfoclose.com
                mailboxes (support, billing and general enquiries): the messages you send us.</li>
              <li data-testid="privacy-polar"><strong className="text-foreground">Polar</strong> - for purchases, Polar Software, Inc. acts
                as merchant of record and processes your payment and billing details as an independent controller
                under its own privacy terms. We receive your name, e-mail, account reference and the payment outcome,
                never card numbers.</li>
              <li><strong className="text-foreground">Intuit</strong> - authorization and source requests for
                QuickBooks connections. Customer QuickBooks connections are not
                currently available (section 8).</li>
            </ul>
            <p className="mt-3">Optional AI providers are described in section 9.</p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">7. Contact</h2>
            <p>
              For privacy questions, access or deletion requests, or support,
              email{" "}
              <a href={mailtoHref("support")} className="underline hover:text-foreground">{channel("support").address}</a>.
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
            <p data-testid="privacy-hosting">
              Personal data is stored and processed outside Tanzania by the service providers listed in section 6,
              which include providers based in the United States. Content delivery, support and operational processing
              can involve other locations. We do not promise that all processing is confined to your country. Any
              future external AI processing requires the review described above.
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
