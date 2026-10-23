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
   identity under the existing lineage lock. It records an append-only canonical document, evaluation and audit event.
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
