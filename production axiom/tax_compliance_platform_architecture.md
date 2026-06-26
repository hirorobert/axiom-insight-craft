# Tax Compliance Reconciliation Platform
## System Architecture Design — Multi-Reviewer Specification

**Codename:** Kinga (Swahili: "shield/protection")
**Purpose:** Continuous reconciliation between business accounting records, TRA's EFDMS, payroll, and statutory withholding/duty obligations — turning annual surprise tax examinations into monthly, low-stakes corrections.

---

## 1. Problem Statement (grounded in real evidence)

The TRA examination notice reviewed shows six recurring failure classes:
1. Sales: financial statements vs EFDMS variance (TZS 289K)
2. Purchases: financial statements vs EFD variance (TZS 103.6M)
3. Skills Development Levy (SDL): unpaid against actual payroll (TZS 3.4M w/ interest)
4. Withholding Tax (WHT) on professional services: unapplied 5% (TZS 202K w/ interest)
5. WHT on rent: unapplied 10% (TZS 1.24M w/ interest)
6. Stamp duty on lease: unpaid, 200% penalty (TZS 354K)

**Root cause across all six:** no continuous, automated cross-check between (a) the general ledger, (b) the EFDMS transaction feed, (c) payroll register, and (d) a statutory-obligation rules engine keyed to expense categories. The failure is structural and recurring — not a one-off bookkeeping error — which is why it is solvable by software and why demand for the fix is recurring (subscription-shaped), not one-time.

---

## 2. Product Architecture — Principal Product Architect lens

### 2.1 Core modules
- **Ingestion Layer**: pulls/receives data from EFDMS, bank statements, payroll systems, and general ledger/accounting software (QuickBooks, Sage, Tally, local ERPs, or manual CSV/Excel for SMEs without modern systems).
- **Reconciliation Engine**: continuous diffing of GL vs EFDMS sales/purchases, flagging variances above a configurable materiality threshold *before* year-end, not after.
- **Statutory Rules Engine**: a declarative rule set mapping expense/income categories to obligations (e.g., "rent expense → WHT 10% + stamp duty on lease"; "professional fees → WHT 5%"; "payroll → SDL liability calc"). Versioned against Tanzanian tax law (Income Tax Act CAP 332, Stamp Duty Act 1972, VAT Act), with a path to add Kenya/Uganda rule sets later.
- **Audit-Response Generator**: when a real TRA notice is logged (often by the user simply uploading the PDF, as was done here), the system extracts findings via document parsing + LLM-assisted classification, maps each finding to the relevant rule and the underlying ledger evidence, and assembles a structured response pack — built to fit the 14-day statutory response window.
- **Multi-client dashboard** (for accountants/audit firms): single login, portfolio view across all client entities, prioritized by risk/variance size.

### 2.2 Why this product shape, not a generic accounting app
The wedge is **reconciliation + statutory obligation detection**, not bookkeeping itself. This is intentionally a layer *on top of* whatever system the business already uses (or doesn't), which avoids competing with QuickBooks/Tally/Sage and avoids replicating TRA's own free EFDMS pipe — the objection raised earlier in this conversation. The product wins specifically where government systems have no incentive to build (workflow, defense, audit-readiness) and where general ledger software has no visibility (cross-referencing against TRA's own data + statute-driven rules).

---

## 3. Distributed Systems & Performance Architecture

### 3.1 Why this must be event-driven, not batch-only
EFDMS pre-clearance is real-time (invoice → EFDMS token → approval → customer). To catch variances *while explainable* rather than at year-end, ingestion should be **event-driven**: each EFDMS transaction triggers an incremental reconciliation diff against the ledger, rather than a nightly batch reconciling everything from scratch.

**Pattern:** Change Data Capture (CDC) from the ledger database + webhook/polling ingestion from EFDMS → message broker (Kafka or a managed equivalent like AWS MSK/Confluent Cloud) → stream processing layer (e.g., Flink or a simpler consumer-group model if volume doesn't yet justify Flink) → reconciliation service → alert/notification service.

### 3.2 Scale assumptions (Staff Engineer / Performance Lead lens)
Realistic initial scale: thousands of SME clients, each generating dozens to low-hundreds of EFDMS transactions per day. This is **not** a millions-of-transactions-per-second system at launch — over-architecting for hyperscale before product-market fit is a real risk. Design principles:
- Start with a modular monolith or a small set of well-bounded services (ingestion, reconciliation, rules engine, notification) rather than 20 microservices day one — this is the correct call for a Staff Engineer to insist on, given team size and actual load.
- Design service boundaries so they *can* be split later (clean API contracts, no shared database across bounded contexts) without needing to split prematurely.
- Define SLOs explicitly: e.g., 95% of EFDMS-triggered reconciliation diffs surfaced to the user within 15 minutes; multi-client dashboard load time under 2 seconds for portfolios up to 500 clients.
- Load-test against realistic SME transaction volume *and* against the bursty pattern of month-end/quarter-end filing deadlines, since usage will spike predictably around statutory deadlines — capacity planning should anticipate this, not be surprised by it.

### 3.3 Failure modes to design for explicitly
- EFDMS/TRA API downtime or rate limiting — the system must degrade gracefully (queue and retry, never silently drop a reconciliation event) since a missed variance is a compliance failure, not just a UX bug.
- Idempotency on ingestion: EFDMS data is financial — duplicate processing must never double-count a transaction. Use idempotency keys on every ingested record.

---

## 4. Database Architecture — Database Architect lens

### 4.1 Data classification drives engine choice
- **Transactional ledger and reconciliation data**: relational (PostgreSQL), because correctness, ACID guarantees, and auditability (every row must be provably unaltered after the fact) matter more than horizontal write throughput at this scale.
- **Append-only audit trail**: every reconciliation decision, every rule evaluation, every user action must be stored in an **immutable, append-only event log** (e.g., a dedicated `audit_events` table with no UPDATE/DELETE permission at the application layer, or event-sourcing pattern) — this is non-negotiable for a Banking Core Systems Auditor review, since the entire value proposition is "we can prove what happened and when" if TRA disputes a filing.
- **Document storage** (uploaded TRA notices, lease agreements, bank statements): object storage (S3-compatible) with metadata indexed in Postgres, never stored as BLOBs in the relational database.
- **Multi-tenancy model**: row-level security with a `tenant_id` on every table, enforced at the database layer (not just application logic) — this is the single most important database-architecture decision for a system holding multiple businesses' financial records, since an application-layer-only tenant check is a recurring source of real-world data leaks.

### 4.2 Schema-level statutory rule versioning
Tax law changes (rates, thresholds — e.g., the TZS 11M EFD threshold, WHT percentages). Rules must be **versioned and effective-dated**, never hard-coded or destructively updated, so that a reconciliation run against 2024 data always uses 2024 rules even if rules change in 2026. This directly prevents a real failure mode: silently mis-auditing historical periods after a rule update.

---

## 5. Security Architecture — Security Architect lens

This system holds the most sensitive category of business data: full financial records, payroll, tax filings, and bank statements, across many client businesses. Treat it like a banking-adjacent system, not a generic SaaS app.

- **Tenant isolation**: enforced at database (RLS), API gateway, and application layers — defense in depth, not a single point of trust.
- **Encryption**: at rest (database and object storage) and in transit (TLS 1.3 minimum), with field-level encryption for the most sensitive fields (bank account numbers, TINs) in addition to disk-level encryption.
- **Authentication**: MFA mandatory for accountant/firm-level accounts given the blast radius of a compromised multi-client login; role-based access control distinguishing "view only," "preparer," and "approver" roles, mirroring real audit-firm sign-off workflows.
- **Audit logging of access, not just data changes**: who viewed which client's data and when — this matters both for security forensics and because accounting firms themselves have professional confidentiality obligations to their clients (NBAA standards).
- **Secrets and credential management** for EFDMS/bank/payroll API integrations: a dedicated secrets manager (Vault or cloud-native equivalent), never credentials in application config or code.
- **Data residency consideration**: Tanzanian data protection law and likely TRA expectations may require careful consideration of where financial data is hosted; this should be confirmed with local counsel before architecture is finalized, not assumed.

---

## 6. Enterprise Integration Architecture

### 6.1 Integration surface
- **TRA EFDMS**: primary data source — integration approach depends on what TRA actually exposes (API, file export, or only the taxpayer-facing portal); design an adapter layer so the core reconciliation engine is decoupled from the specific ingestion mechanism, since this will likely evolve as TRA's own platform matures (as seen with VFD's 2020 introduction and the 2025/26 expansion to all taxpayers).
- **Accounting software connectors**: QuickBooks, Sage, Tally, and a generic CSV/Excel importer for SMEs on manual bookkeeping — design one canonical internal ledger schema and write adapters *into* it, rather than building bespoke logic per accounting system.
- **Payroll systems**: similar adapter pattern for SDL/PAYE calculation inputs.
- **Banking integration**: for cash-flow analysis (as referenced in the TRA notice's "Cash flow analysis... Refer attached Working Paper") — likely starts as bank statement upload/OCR before any real-time bank API integration is feasible in this market.

### 6.2 Integration resilience
Every external integration must have a circuit breaker and a degraded-mode fallback (e.g., manual CSV upload when an automated feed fails) — given that TRA systems and many local accounting tools are not engineered to enterprise-grade uptime standards, the product cannot assume its dependencies are always available.

---

## 7. Mobile Systems Architecture

Given Tanzania's mobile-first usage pattern (smartphone-dominant, intermittent connectivity outside Dar es Salaam):
- **Offline-first design** for the mobile client: accountants/SME owners must be able to review flagged variances, approve responses, and capture document photos (e.g., snapping a lease agreement or receipt) without continuous connectivity, syncing when back online — using a local-first data layer (e.g., SQLite with a sync engine) rather than assuming an always-on API call.
- **Lightweight core app**: prioritize fast load on mid-range Android devices and low-bandwidth conditions over rich UI — this is a finance/compliance tool, not a consumer entertainment app, and should be designed and tested accordingly.
- **Document capture pipeline**: camera-based capture of physical documents (leases, receipts) feeding into OCR/parsing, since much of the SME source data referenced in the TRA notice (lease agreements, board resolutions, loan contracts) will not exist as digital originals.

---

## 8. Banking Core Systems Auditor sign-off checklist

For this design to pass a banking-grade audit review, it must demonstrate:
- [ ] Complete, immutable audit trail of every reconciliation decision and rule version applied
- [ ] Tenant data isolation enforced at multiple layers, independently verifiable
- [ ] No destructive updates to historical financial records — corrections are new entries referencing the original, never overwrites
- [ ] Reconciliation logic is deterministic and reproducible — given the same inputs and rule version, output must be identical every time, so a TRA dispute can be defended with a reproducible calculation
- [ ] Segregation of duties supported in the product itself (preparer vs. approver roles), mirroring real accounting-firm controls

---

## 9. Honest risks and open items (the part a real review board would flag)

- **EFDMS integration access is unconfirmed** — whether TRA exposes a usable API/feed for third-party reconciliation tools, or only a taxpayer-facing portal, materially changes the ingestion architecture and must be validated directly with TRA before committing engineering resources.
- **Legal/regulatory review required** before launch — handling client tax and financial data at this scale likely requires data protection compliance review and possibly registration/disclosure considerations specific to Tanzania; this is not optional due diligence.
- **Statutory rule engine requires ongoing legal maintenance**, not just initial build — tax law changes need a real process (likely a part-time tax/legal consultant relationship) to keep the rules engine accurate, or the product itself becomes a liability if it gives wrong guidance.
- **This is genuinely buildable by a strong solo/small technical team** at MVP scope (ingestion adapter for one accounting system + EFDMS + the rules engine for the six obligation types proven in the sample notice), with the full multi-tenant, multi-country, mobile-offline architecture as a real but later-stage build — sequencing matters more than building everything at once.

---

## 10. Recommended build sequence (ties architecture to realistic execution)

1. **MVP**: single-tenant reconciliation tool covering the six proven obligation types (sales/purchase variance, SDL, WHT-services, WHT-rent, stamp duty), manual document upload, one accounting-software adapter (or CSV).
2. **V2**: multi-tenant accountant dashboard, EFDMS integration (pending access confirmation), audit-response generator.
3. **V3**: mobile offline-first client, additional accounting-system adapters, banking integration for cash-flow analysis.
4. **V4**: regional rule sets (Kenya eTIMS, Uganda EFRIS) reusing the same architecture, since the underlying pattern — government e-invoicing pipe + private reconciliation/workflow layer — repeats across the region.
