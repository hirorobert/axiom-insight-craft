# Guided equipment preparation — draft implementation

## Scope and status

Base: `fb7c547565826b417ca01619713720760de3d166` (merged correction PR #205).
Branch: `feat/guided-equipment-preparation`.

This candidate adds **preparation assistance** to Financial Statements → Schedules for IFRS for SMEs 2015. It is not a new reporting engine, a completed framework pack, or a claim that the entire preparation initiative is finished. No hosted write, migration, deployment, publication, financial decision or paid API call is part of this implementation.

The approved broader milestone remains: current TB + available prior information → only unresolved questions → supported opening bridge → equipment movements → linked policy and note → independent review and issuance. This candidate implements the bounded browser workpaper and connects its schedule to the existing server authority. Server retention of the complete workpaper and original report, safe policy insertion, full PDF-browser verification, and real accountant usability acceptance remain open. **Do not describe those as delivered.**

## What changes

1. A normal Schedules-page entry point, five named preparation steps, direct next-step links, and the existing shared unsaved-work/navigation protection.
2. A selected-page PDF reader, including scans. PDF.js renders a bounded page; Tesseract performs English OCR if the page has insufficient text or the preparer explicitly requests it for a mixed page. The displayed original page remains the review source. Extracted text is not automatically turned into accepted financial facts.
3. The browser hashes the original PDF and retains page number, printed amount, currency and units in the downloadable workpaper. Reviewed manual source references are an explicit alternative; no document hash or audited status is fabricated for them.
4. An opening bridge with signed adjustments, reasons and evidence references. The anchor uses the saved prior end date, or the day before the saved current start date when no prior TB exists; no January–December period is assumed. Arithmetic agreement does not approve an adjustment or amend comparatives. A residual is never classified as a receivable by this workflow.
5. Exact movement reconciliation against the server's current PPE statement line. Blank, unknown, zero and differences remain distinct. Two TBs alone are not represented as proof of additions, disposals or cash flows. The preparer can cite an explicitly reviewed movement-account working paper or a register/ledger.
6. Structured equipment policy choices and an original-wording policy draft. Useful lives and residual values are supplied by the accountant; no statutory/tax default is inferred from the depreciation charge. Revaluation is labelled as requiring a separate assessment. This is equipment wording, not a complete accounting policy note.
7. An explicit schedule save through the existing `fs_record_schedule` authority, with stable request identity and a required submission receipt. An uncertain result retains its request identity. Existing schedules require a specific whole-schedule replacement confirmation. This first editor supports one class; the existing multi-class editor remains available.
8. A workpaper download and a separate policy-copy action. Neither claims server persistence, approval or compliance. Notes and Comparatives links preserve company, period and selected report-version routing through the canonical `hrefFor`.

No direct table write, new RPC, altered compiler, changed framework applicability, automatic mapping decision or approval bypass is introduced.

## Trust and freshness

- `compositionSha256` identifies the server figures reviewed by the preparer. Changed composition keeps the workpaper but blocks saving until refreshed figures are reviewed and the source figure reconfirmed.
- A different company or period unmounts pending reads. Late responses cannot populate a new workpaper.
- Server readiness, schedule reconciliation, reviewer permissions, restatements and issuance remain the existing authorities. Local arithmetic is advisory; it cannot authorize FINAL.
- The PDF is processed locally, not uploaded by this feature. The downloaded workpaper does **not** contain the original PDF. The user is told to retain it separately.
- Policies are **not** silently appended to or substituted for an existing policy note. Atomic, version-checked insertion and retained structured answers require subsequent reviewed server work.
- The feature is admitted only on the existing SME 2015 composition. No IPSAS/full IFRS access or framework-support claim changes.

## OCR deployment and resource bounds

Runtime libraries: pinned `pdfjs-dist@6.4.299`, `tesseract.js@6.0.1`, `@tesseract.js-data/eng@1.0.0`; transitive bytes are locked by Bun.

`scripts/build/localOcrAssets.ts` supplies the worker, LSTM WASM cores and English language data from the same app origin in development and production. It also emits notices. No external OCR/CDN request is required. Runtime assets are emitted separately and fetched when required; they are not in the initial JavaScript bundle. PDF decoders, CMaps and fonts are also hosted on the same origin.

- PDF: 20 MiB maximum, 200 pages maximum; one selected page per operation.
- Render: at most 2,000,000 pixels; finite positive dimensions required.
- Runtime: 120-second deadline, explicit cancellation, worker/document cleanup, no persistent OCR cache.
- Output: at most 60,000 extracted text characters for the selected page.
- English OCR only. Ambiguous glyphs, signs, table columns and units require review; OCR success does not prove an accurate report extraction.
- XFA disabled; the app does not register or execute document actions. It requests a rendered page and text from the PDF parser. Decoder/runtime security is still a dependency boundary, not a claim of formal PDF safety.

A real Node OCR smoke check exercises the locked local engine/model against an original synthetic scan. It is **not** a browser-worker, mixed-PDF, mobile-resource or hosted end-to-end proof.

## Fixture evidence and limits

The existing controlled SME fixture supplies equipment opening 16,000, depreciation (2,000), closing 14,000. It does not establish useful life, residual value or an accounting policy; the candidate leaves those unanswered.

The unit suite also includes an **Enduimet-shaped missing-PPE scenario** that stays incomplete instead of inventing an asset. Actual Enduimet source documents, approved adjustments, register and control evidence are unavailable in this worktree. That test is not a reproduction or validation of the actual Enduimet engagement, and it does not validate IPSAS disclosures.

No universal claim that two TBs reconstruct gross movements is made. Automated semantic detection of government movement accounts is not implemented.

## Validation commands

- `bun run test src/lib/preparation src/components/reporting/EquipmentPreparation.test.ts`
- `node scripts/preparation/ocrSmoke.mjs` (synthetic image, local locked assets, no API)
- `bun run test` (full repository suite; skipped/TODO tests must be reported separately)
- `bunx tsc --noEmit -p tsconfig.app.json`
- `bun run lint`
- `bun run build`
- `node scripts/ci/assertPackIsolation.mjs dist`
- `node scripts/buildStatementCompiler.mjs --check`
- `node scripts/ci/assertMigrationAuthority.mjs`
- `node scripts/ci/releaseJournal.mjs`
- `node scripts/ci/assertSingleLockfile.mjs`

Local validation results are reported in the PR against its exact candidate commit. CI and a real browser journey must not be inferred from unit results.

## Remaining completion work (not done by this candidate)

| Requirement | Evidence needed before claiming completion |
|---|---|
| Retained source/report and structured workpaper | Authenticated, revisioned persistence; original bytes; tenancy and freshness proofs; approved migration/transport if needed |
| Safe policy-to-note handoff | Reviewable insertion that preserves other policies, detects concurrent changes and binds the structured answers to the reporting revision |
| Full equipment disclosure | Gross cost/accumulated depreciation and all applicable disclosures, cross-references and reviewed accounting content; carrying-value reconciliation alone is insufficient |
| Comparative bridge approval | Existing governed comparative/restatement path exercised with supported adjustments; this browser bridge is not an approval |
| Actual Enduimet fixture | Source documents, extraction review, evidence-backed reinstatements and control judgments; anonymization/permission if needed |
| Scan/PDF browser proof | Searchable, scanned and mixed-page PDFs; cancel/timeout; same-origin-only network proof; narrow screens and supported browsers |
| Accountant task acceptance | Named preparer/reviewer; complete the supported journey without live coaching; record corrections, elapsed time and remaining gaps |
| Wider frameworks | Edition/jurisdiction resolution, applicable standards content, calculations, disclosure fixtures and independent accounting review; not merely relabelled SME templates |

Content author and independent accounting reviewer: **not assigned**. No customer launch/compliance sign-off follows from this PR.

## North-star architecture retained

Source adapters → reviewed facts with provenance → opening bridge → supported schedules/treatments → presentation lines → policy and disclosure answers → deterministic tie-outs → versioned server compilation → governed review and issuance.

Build the next area against this contract after the equipment path is proven. Do not rebuild existing SME calculations or start ERP connectors to bypass missing preparation content. Full IFRS and IPSAS remain explicit parallel content/research workstreams, not implied support in this preparation assistant. None of this authorizes paid research, hosted installation, merging or publication.

## Revision 2 — referenced preparation content and persistence candidate (27 October 2026)

This section supersedes the earlier statements that the candidate contains no new RPC or SQL. **Hosted state is unchanged.** New SQL is deliberately inert at `release/candidates/guided-equipment-r1/workpaper.sql`; it is not an authored/applied migration or a journal mirror. The candidate must pass its disposable-database proof, independent review and canonical migration registration before hosted installation is considered.

Implemented in this revision:

- Original-wording SME 2015 equipment questions with paragraph references, primary-source URL, checked date, content version and explicit independent-accountant-review-pending status. Existing structured policy answers are reused rather than asking the same question again. Revaluation questions are conditional. UN material is not substituted for SME requirements.
- Gross opening/closing amounts, accumulated depreciation and impairment, checked independently against carrying amounts. A blank deduction remains unknown; the user must confirm zero. These display deductions do not change original ledger signs.
- A disclosure preview combining confirmed preparation inputs and reconciled amounts, without invented note numbers or a compliance verdict.
- Strictly scoped, bounded restoration of saved editor data. Restoring answers does not restore an original PDF preview or automatically reconfirm evidence.
- An authenticated append-only workpaper store with expected-revision checks, request replay, exact request reuse checks, no direct API-role table writes and no UPDATE/DELETE/TRUNCATE history rewriting.
- Compare-and-set insertion into either accounting policies or the broader subclassifications disclosure. Existing wording is presented and preserved in a proposal; the preparer must review the WHOLE destination note. PPE wording alone is never presented as complete policies or all subclassification disclosures. Another writer's newer text causes refusal rather than overwrite.
- A database commit function that records the workpaper revision, calls the existing validated schedule authority and records the selected reviewed note in one transaction. Any refused schedule/note rolls back the new workpaper and schedule. Stable derived step IDs support receipt replay. Request locks precede the period lock.
- Explicit unknown-outcome recovery retaining the original atomic request and its preconditions; editing later browser inputs cannot change the retried operation. Loading a newer note does not silently adopt its revision for an old proposal.
- Optional original-PDF retention through the EXISTING `financial-statement-intake` transport. Its malware scan and membership checks remain intact. A receipt is not treated as a linked source until the workpaper function verifies the document's company and fingerprint. A missing original is recorded as not retained; quarantined/failed/superseded sources cannot be inserted as current support.

Deployment and product limits:

1. The existing document intake requires accepted firm membership and a configured, available malware scanner. Owner-only access without that membership is not repaired here. No membership is fabricated, no unscanned storage bypass is introduced, and no paid scan/provider call has been made for validation. This is an explicit remaining integration limitation, not a passed owner-only retention journey.
2. The source proof links synthetic document METADATA; it does not prove that a production storage object exists or has the right bytes. Real retained-original testing is still required through the normal authenticated intake.
3. No new SQL has been applied hosted. The candidate functions do not exist there until separately reviewed and installed. The UI reports unavailable storage rather than claiming a save.
4. The local environment cannot run PostgreSQL as a non-root user. The new real-database proof is wired to CI's disposable PostgreSQL container. Do not report that proof as locally executed.
5. The earlier end-to-end and DB checks at `b9daaf7e` do not clear this larger revision. Final candidate CI must be checked again.
6. Accountant-led usability, actual Enduimet evidence, current-period recognition/measurement judgments and wider-framework support remain open. A source-reference catalogue is not a verified standards-compliance engine.

Reference review: IFRS Foundation Module 17 explicitly covers the 2015 edition; educational commentary is distinguished from the Standard. The product contains original questions and links, not copied illustrative reports, source PDFs or Foundation logos. Commercial content permissions remain to be established before licensed content is embedded. UN Chapter 16/Corporate Guidance remain comparison/research references for a separately admitted IPSAS pack; older IPSAS references and UN-specific policies must not become universal product rules.


## Accounting assessment reconciliation — PR #209

Reviewed accounting handoff at db8dccbd47bfe52323e8711c530349fb6cf730cc against candidate a7182309. Charter references: P1/P4, G4/G5, section 11.3 atomicity and 11.5 coverage acceptance. Charter remains pending adoption.

Confirmed release protection: single-class wizard no longer replaces an existing PPE schedule. It links to the full schedule editor; workpaper export remains available. The atomic candidate also rejects a latest multi-class schedule under the existing period lock, before writes; exact prior request replay is preserved. New component and real-DB cases exercise these paths. This is a protective restriction, not a multi-class guided implementation.

Confirmed follow-ups, not solved here: gross rollforward and movement provenance; structured per-class depreciation estimates; disposal proceeds and gains/losses; conditional disclosures and pack coverage; reusable requirement-linked answers and restatement integration. Depreciation need not all appear as one expense line (e.g. capitalization or by-function presentation): follow-up must reconcile destinations rather than impose unconditional equality. Reviewed prose and arithmetic do not establish full equipment compliance. No framework content or compiler changes authorized by this reconciliation.

Original PDF retention still depends on membership and scanner availability; authenticated browser/accountant acceptance and canonical migration promotion remain open. No hosted changes or paid calls performed. Previous green CI applies only to a7182309; revised checks must pass on the new commit.


## Canonical authored source — pending installation

The reviewed candidate is now byte-identical to authored source `supabase/migrations/20261205100000_fs_equipment_preparation.sql`. This supersedes the earlier statement that no authored source exists. The migration authority must report exactly this pending source, with no new Drizzle mirror or hosted journal entry. CI applies the authored source once through its full disposable chain; the equipment proof checks candidate parity rather than applying it twice. Historical proof guards admit only this exact additional filename.

No hosted installation, expected hosted journal head or active rollout is asserted. The final source still requires review and final-SHA CI. Authenticated retained-original browser testing and accountant acceptance remain outstanding. This does not authorize installation or publication.


## Final release review — create-only wizard schedule path

Confirmed a time-of-check/time-of-use gap in schedule-only saving: the browser could see no schedule and the generic existing replacement RPC could later overwrite a concurrently created schedule. The wizard now calls `fs_create_equipment_schedule`, which checks permission and takes the shared period lock, refuses an existing schedule for a new request, and delegates validated exact-request replay to the existing schedule authority. The full multi-class editor retains its existing deliberate editing workflow. Added component refusal/retained-edit coverage and real-DB create concurrency, duplicate replay, changed-intent refusal and viewer denial. Both SQL copies remain byte-identical; the previous source digest is superseded and must not be used for installation. Final-SHA CI is required again. No hosted changes made.
