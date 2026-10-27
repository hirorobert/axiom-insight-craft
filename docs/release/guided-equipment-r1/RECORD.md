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
