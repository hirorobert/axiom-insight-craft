# Equipment guided start — review and candidate

## Verdict and scope

Frontend-only follow-up to the observed equipment acceptance friction. No new migration, Edge Function, framework, accounting default, approval policy, AI call or hosted financial write. Applies only to the existing IFRS for SMEs 2015 preparation. Existing installed history and exact-byte transport are untouched.

Charter mapping: B1/B3 acceptance, P1/P2/P6/P7, R1/R5/R7 and §§11.1/11.3/11.5. Charter adoption/accounting review remains proposed; existing AGENTS.md controls govern. This is a tested candidate for owner review, not a new compliance or deployment claim. No merge/publication/activation is authorized by this record.

## Evidence baseline and hostile findings

Source baseline: main `fc42a30dd5ae987e2b9cf4518b51b56bb2b629b7` (tree-identical to bookkeeping `a3dd514b`). Installation of hosted 89–91 is recorded by Lovable; source/transport/mirror checks and final-source unit/typecheck/build were independently run locally. Independent live database bundle attestation is not claimed.

A signed-in read-only browser check of CFOClose Complete Test FY2025 observed: normal access; server-composed PPE opening TZS16,000/current TZS14,000; existing schedule reconciliation; new context RPC read; recorded class loaded into a browser-only draft. No workpaper/answer/note save, approval, issuance or paid call was made. Those observations prove the read path, not completed accounting acceptance.

| Finding | Evidence / conclusion | Candidate change |
|---|---|---|
| Hidden initial read | `EquipmentServerBridge.tsx` read only when its bottom button was clicked; a second button loaded classes. Live page initially showed zero draft classes despite one existing class. Confirmed product friction. | Read automatically on guided-pane mount; prefill recorded classes only for a pristine draft without a saved workpaper. Saved workpaper restoration stays explicit. No assumptions about gross columns, useful lives or evidence. |
| Zero rows | `classFromScheduleRow` preserved the server's net movement rows. The live record contained zero-net entries; the loader did not invent those entries. My earlier shorthand that these were simply unnecessary rows was inadequate: zero net may hide a fully depreciated disposal or offsetting gross changes. | Keep every row on load. Collapse eligible recorded zero-effect entries for review; permit explicit removal only after a named checker supplies evidence. Retain the removal decision as an existing-contract answer (`zero_effect_row_review`), including movement kinds. Nonzero/cancelling gross columns, invalid precision and arbitrary new blank rows cannot be bulk-removed by this control. |
| Currency warning | `depreciationTieOut` exposed raw minor values in its problem strings; live text showed 200000 while the charge was TZS2,000.00. This was display, not an arithmetic error. | Optional exact currency formatting for UI warnings, including roll-forward/charge/destination checks and question explanations. Integer outputs, conditions and server calculations unchanged; raw messages remain default for existing non-UI callers. |
| False zero confidence | Before classes existed, a mathematical empty-sum tie-out displayed that the whole charge was accounted for. Recording was still blocked, but the message was misleading. | Explain that classes must be loaded/added before a zero charge is established. No gate removed. |
| Incomplete fixture | Original acceptance PPE CSV only contains net opening/depreciation/closing; note CSV explicitly has unreviewed placeholders. It does not establish lives, residuals or management facts. | Add explicitly fictional, test-only register/scenario/editor inputs tied arithmetically to the original TBs. No production autofill/import, no claim of real management review. |

## Implementation boundaries

- Initial reads are generation-scoped; superseded/unmounted reads cannot update current context. StrictMode duplicate reads do not become writes. Late initial responses cannot erase typed classes. Read/write admission has synchronous locks; read activity says Reading, not Recording. No automatic write/retry introduced. Existing uncertain-commit request identities and replay/refusal controls preserved.
- A saved workpaper never restores automatically. A prepared or edited browser draft remains in place after read refresh/refusal. Existing class preservation, server revision checks and reviewed whole-note insertion stay authoritative.
- Zero cleanup is a preparer operation, not a new accounting exemption. The retained answer records the removal decision at that preparation step; subsequently added movements still require their own sources and reconciliation. The original schedule remains immutable and the commit binds its expected revision. The server records actor/answer/transaction; it does not independently prove that the asserted absence of events is true. Qualified review remains necessary.
- Currency presentation uses BigInt-backed `formatMinor`, with no floating-point conversion. Display metadata changes text only; tests compare exact state/amount fields with and without it. No sign, source amount, rounding rule, depreciation calculator or SQL mirror changes.
- Synthetic useful life ten years and nil residual are declared fictional assumptions, not recommended/prefilled customer policy. The new scenario supplements, never edits, original acceptance files. No evidence is auto-confirmed or uploaded to hosted by this change.

## Synthetic test case

Folder `fixtures/`: `scenario.md`, `equipment-register-FY2025.csv`, `synthetic-equipment-case.json`. All clearly identify synthetic software testing and no compliance assertion. JSON is test data, not an implemented production importer; CSV is a human-readable evidence example, not a new CSV parser feature.

Declared hypothetical E-001: available 2023-01-01; cost TZS20,000; ten-year straight-line/full-period; nil residual; FY2025 depreciation TZS2,000; opening accumulated depreciation TZS4,000, closing TZS6,000; no impairment; carrying TZS16,000 to TZS14,000. No additions, disposals or other events in this fictional case. Depreciation is part of the TZS9,900 operating-expense line, not equal to the entire line. Original account codes91500/91510/96200 are cited in the fixture only, never special-cased by product logic.

Test computes charge from items, both gross/net roll-forwards, opening bridge, destination reconciliation and question resolution, and produces policy/equipment wording. A rendered component test also restores this FY2025 case, confirms it explicitly, prepares all three whole notes preserving existing wording, records through a fake transport, reloads and requires confirmation again. That is not a live save test. It proves software behavior for declared hypothetical facts; human review, all other notes, comparatives, report sign-off and issuance remain separate. Live save/reload/note insertion have not been performed on this candidate.

## Verification

- Three tests added before implementation failed on baseline: automatic context/class load; failed initial read recovery; display of a monetary mismatch. Baseline log: 12 passed/3 failed, each failed for its named assertion. After the fixes all three pass. Existing component tests retained.
- Additional tests: late read after typed edits; saved workpaper explicit restore; StrictMode stale response; company remount; read/save same-turn race; initial no-false-zero message; zero-effect entries retained until explicit evidence; draft payload retains decision; fully depreciated disposal cannot be bulk-dropped; invalid precision/new blank rows retained; no source mutation; BigInt large/negative/zero-/three-decimal formatting; unchanged exact reconciliation result; complete declared synthetic case.
- Real database proof extends `equipmentMulticlass` manifest by one case: the existing atomic RPC stores/replays the zero cleanup answer with authenticated lineage and preserves reconciled classes. No migration edited. Database result PENDING CI; not run locally (unprivileged PostgreSQL startup unavailable here).
- Browser journey now exercises automatic initial read/load, explicit evidenced zero-row cleanup and retention of its answer on the real component over its existing disposable database bridge. This remains loopback bridge evidence, not hosted-accountant completion.
- Local full suite: 6,670 passed, 10 skipped, 12 todo. Typecheck/build passed. Lint: 0 errors, 180 pre-existing warnings; exact-SHA CI evidence reported in the PR. No paid or hosted actions.

## Release path and remaining work

Independent code/accounting review as appropriate → final-SHA CI → explicit owner merge authorization → sync/publish matching frontend. **No new backend installation or Lovable build prompt is needed for this candidate.** Re-run live normal signed-in synthetic preparation after publication; confirm/save/reload the workpaper and reviewed notes without touching earlier FINAL history. Do not claim completed SME statements or general launch readiness from this slice.
