# Independent compilation of official financial reports

## Scope and demonstrated defect

This completes the server trust boundary for the existing supported standalone IFRS for SMEs 2015 reporting slice.
It does not replace Trial Balance processing, add another framework, change rollout access or certify the truth of a
preparer's underlying records. The earlier broad claim that the server did no accounting was obsolete: composition,
evidence-statement figures, disclosures, dependency binding and sign-off controls already existed.

The residual gap is reproduced by `scripts/db-proof/publicationControls.mjs`: with only the new compilation guard removed,
correct retained facts and an empty client findings list allow omitted equity lines, a false heading, an omitted binding,
a false presentation currency and a false entity name through REVIEWED and FINAL. Restoring the guard refuses the same
payloads. These cases run only in an isolated throwaway database, never a customer project.

## Authority and state transitions

1. The ordinary save writes a resumable immutable DRAFT through the existing idempotent revision command.
2. `compile-financial-report` accepts only company ID, report ID and version; it verifies the caller with Auth.
3. `fs_server_compile_input` checks current capabilities and rollout, then reads bounded authoritative sources for that
   exact version: composition, notes, dependency identity, reporting input, current bound evidence and the disclosure
   texts actually selected by the notes authority. It does not use a truncated browser table page or client-supplied figures.
4. The trusted runtime revalidates the evidence records with the existing family schemas, including dates, precision,
   required columns and cross-row constraints; it ignores the preparer's VALID flag. It builds the complete canonical
   document and runs the existing canonical rule pack. The generators, schemas and rules are shared, not reimplemented.
5. A service-only receipt command rechecks permission, rollout, latest version, document identity and current dependency
   identity under the existing lineage lock. It rereads and compares the complete source snapshot, then records that
   snapshot, its database-computed SHA-256, the exact deployed compiler digest, canonical document, evaluation and audit event.
   Exact retries return the same receipt. A response lost after committing is safe to retry without another version.
6. New REVIEWED/FINAL writes, including direct writes, require a matching receipt and an independent server evaluation
   without blocking findings. Complete JSON equality covers headings, line bindings, missing/extra structure, periods,
   currency, scale, edition, entity identity, notes and figures. Client evaluation writes cannot replace this authority.
   Existing mandatory ties remain unwaivable; a client reviewer decision cannot override the server compilation gate.
7. New official issuances also require the receipt, including issuances against a pre-existing FINAL. Historical reports,
   approvals and already-issued objects are not rewritten; existing artifact verification/retrieval remains unchanged.

A server/source-read failure leaves a saved draft unapproved and reports that the server check is unconfirmed. Retrying
resumes the existing version. Unsupported editions remain saved drafts with the existing named refusal. No new approval
or issuance can fall back to browser findings when the compiler is missing or fails.

## Deployment and verification

Nothing here applies a production migration, deploys a function, merges or publishes. Keep reporting rollout disabled
while deploying. Deploy the complete `compile-financial-report` closure, apply the exact atomic forward migration
`20261123100000_fs_server_compilation.sql` through the journalled owner process, deploy the matching frontend, exercise
the isolated acceptance journey, and only then enable the intended company rollout. If deployment stops between steps,
keep the rollout disabled; do not remove the approval guard to restore availability. The migration is authored/pending;
no Drizzle row is invented to imply hosted application.

`node scripts/buildStatementCompiler.mjs --check` proves the deployable shared bundle matches its TypeScript source and
installed locked dependencies. The Edge Function never imports files outside its deployable directory. CI type-checks
its real Supabase adapter, runs the pure compiler/HTTP boundary tests, the adversarial database proof, concurrent save /
approval proofs, the real local-Supabase application journey and reporting-browser/PDF journey.

The local database adapter used for early proof runs is PostgreSQL-in-WASM with serialized connections. It is useful for
SQL and positive/negative behavior, not a concurrency claim. Concurrency and platform/Storage/Auth acceptance require
CI's real PostgreSQL and local Supabase jobs on the final commit.

## Boundaries that remain

The compiler revalidates persisted tokenised evidence records. That proves the recorded source obeys the schema and that
the report follows those records; it does not prove the original ledger is truthful or authenticate original file bytes
that this intake never retained. Framework/accounting cases outside the documented 2015 slice remain refused. Company
renames or changed source identities require a new report version for a new approval; issued history retains its original
identity. No absolute accounting-compliance or security certification is claimed.

## Phase 0 acceptance boundary

This change is a server-authority foundation, not approval of the complete framework roadmap. Only Phase 0 is approved
for engineering closure. A passing repository build is not authorization to activate reporting. The release candidate
must identify its exact commit, migration bytes, deployable compiler closure and supported framework/edition.

| Requirement | Current evidence / mandatory closure |
| --- | --- |
| Complete compilation snapshot | The receipt stores the full bounded server source and a database-computed SHA-256. Recording rereads the complete source under the receipt lock and refuses a mismatch. The compiler closure digest is pinned in the pending migration and checked against a generated deployment manifest. Local SQL cases cover missing evidence, changed disclosure inputs and changed identity despite unchanged aggregate IDs; final-commit CI remains required. |
| Comparative restatement | Prior-FINAL acceptance records bind reasons, actor, original report/version and exact computed differences. The prior issued document is preserved. Prove the full reason/authority/adjustment/approval chain and transition disclosures. Acceptance of current-period comparatives must not require issuance of a replacement prior-year report. |
| Publication lifecycle | DRAFT, REVIEWED and FINAL authority is implemented. Specify and prove supersession and withdrawal independently from comparative restatement before claiming complete lifecycle coverage. |
| Issuance recovery | Existing issue/verify/retrieve paths and orphan handling require interruption proofs at every database/storage boundary. An incomplete object must never become an available official pack. |
| Scoped idempotency | Receipt identity includes report, version, compiler, document and dependencies. Exact retries reuse the receipt; different results conflict. Prove the corresponding request identity and conflict rule for every publication and issuance command. |
| Independent signing | A database receipt is not an independent signature. A future signing boundary must enforce authorization outside the compromised database trust domain, protect and rotate keys, and verify a versioned manifest. Arbitrary database-supplied content must not obtain a trusted signature. |
| Treatment coverage | The supported scope remains the restricted standalone IFRS for SMEs 2015 slice. Each additional treatment requires executable rules or an approved judgment workflow, independent expected-result fixtures and named unsupported-case refusals. |
| Exposure incident | Confirm P-1 separately and immediately. Record exposed files/history and any credentials, containment, accessible-copy removal and credential rotation where applicable. Repository privacy cannot recall clones or downloaded data. Do not record incident closure without evidence. |

Framework prioritization is provisional: committed customer scope, applicable period **start**, adoption requirements,
transition workload and delivery effort decide order. IAS 1 remains relevant for applicable periods beginning before
IFRS 18 adoption, including non-calendar periods ending in 2027 and historical reports. SMEs third-edition transition
requires its own retrospective-application and exception coverage; IFRS 18 transition is not a substitute. IPSAS work
must follow the customer's applicable adoption requirements and reporting period. No unsupported edition is enabled
by this document.

The operational happy path stays one resumable save, an automatic server compilation, review, final approval and a
verified official export. A failure retains the saved draft and gives a retry or a specific required correction.
Retries must not create duplicate versions, approvals or issuances. User-visible readiness is derived from server
state; browser progress, findings and validation flags never establish publication authority.

On 2026-10-24 the service-withholding proof's explicit forward-migration inventory omitted
`20261123100000_fs_server_compilation.sql`. The correction adds that exact reviewed name, preserving exact inventory
comparison and all clean-install, upgrade, refusal, history and concurrency assertions. It does not relax a grant or
change production SQL. Final-commit CI remains required. The compiler HTTP boundary also bounds incoming **bytes while
streaming**, rejects malformed UTF-8, and cancels oversized bodies before compilation or receipt writes.


## Frozen source and compiler identity

Each new receipt retains the exact server-read `saved`, `companyName`, `composition`, `notes`, `dependencies`, `input`,
`evidence` and `disclosures` objects. The trusted runtime detaches this JSON before evaluation. The receipt transaction
rereads the same bounded source under its lineage lock and requires JSON equality before insertion or replay. The
snapshot is compared again by the approval guard. Issuance continues to bind the exact immutable approved report and
receipt; it does not rebuild a historical approval from later live inputs. Existing issued-object retrieval is unchanged.
The snapshot hash is computed by PostgreSQL over the retained JSONB text encoded as UTF-8; it is a database-format audit
identity, not a cross-language JSON serialization claim. A CHECK constraint enforces its correspondence to the stored
snapshot, and existing append-only/privilege guards protect both fields.

`statementCompiler.manifest.mjs` identifies the exact bytes of `statementCompiler.generated.mjs`, including the bundled
generators, evidence schemas, rule pack and dependency closure. The service-only writer accepts only the digest pinned
in the reviewed, still-unapplied migration. The build check detects bundle, manifest or migration-pin drift. A different
compiler requires a reviewed version/digest migration; silently replacing code under the same version cannot satisfy
the deployment check. Receipt audit events record both snapshot and compiler digests.

This assumes the trusted compiler deployment and service credential remain trustworthy. It does not make a database
administrator untrusted within the database's own enforcement boundary and does not provide an external signature.
The separate independent-signer threat model remains open.

Phase 0 baseline execution: commit `d2ea291ad4fc59150565335cb322a07820b79333`, CI run `40060374782`, completed all nine
automatic jobs successfully, including the disposable PostgreSQL contracts and the real local-Supabase/browser journeys.
Manual staging RLS was skipped, not passed. The snapshot/digest extension requires its own final-commit CI results;
baseline success must not be transferred to changed code. Local SQL checks use PostgreSQL-in-WASM with serialized
connections and are not concurrency evidence. No hosted application, activation or incident closure is asserted.

Lock ownership: the public compiler read, receipt writer and approval writer/trigger acquire the report-lineage lock.
The private snapshot reader acquires no lock of its own, so readiness inspection does not silently add a writer lock
and the isolated control-removal concurrency proof can still exercise the preceding publication behavior. Migration
postconditions and the publication proof check this separation; the real concurrency proof must pass on the candidate.
