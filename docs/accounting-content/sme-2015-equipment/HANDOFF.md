# SME 2015 equipment coverage: handoff

**Status:** accounting-content candidate requiring qualified review. Not a compliance certification. No IFRS for SMEs
compliance is claimed. Accounting author and independent reviewer: **unassigned**.

**Date:** 2026-10-27. **Branch:** `docs/sme-2015-equipment-content` from `origin/main` at
`fb7c547565826b417ca01619713720760de3d166`. **Files changed:** only the four documents in
`docs/accounting-content/sme-2015-equipment/` (this file, `REQUIREMENTS_MATRIX.md`, `PREPARATION_QUESTIONS.md`,
`ACCEPTANCE_CASES.md`). No application code, SQL, migration, compiler artifact, dependency, CI, agent instruction or
other branch was touched. Nothing was merged, deployed, published, applied hosted or sent to Lovable; no API credits
were spent; no Enduimet or MUSE material was used.

## 1. Identities reviewed

| Item | SHA / state |
|---|---|
| `origin/main` (base) | `fb7c547565826b417ca01619713720760de3d166` |
| PR #207 head (read with `git show`, never checked out) | `a7182309367ae75c950bf6ba03e6d1d216811a57`, draft, open, no reviews; 29 files; merge-base `fb7c547` |
| PR #208 head (charter candidate) | `b01ed189065a7e9f67727bf9af209f214adc84ac`, draft, open, no reviews, **adoption not recorded** |
| IFRS for SMEs 2015 text | SHA-256 `acc6500e58f9090eddc8e2b55bc531f93e718d320c7c40c695898bb82235eb9f` (1,027,941 bytes), identical to the pin in `src/lib/frameworkPacks/ifrsForSmes.ts:23-24`; Section 17 and the dependent paragraphs re-read 2026-10-27 |
| IFRS Foundation Module 17 (2018-06) | SHA-256 `41e48f069c7ef4e739f003b0646d50f2e409ef731e40afa0289615d3dade8732` (881,262 bytes); used only to confirm the 2015 amendments list and the licence terms |

## 2. The five most important evidenced gaps, ranked

Ranking criteria: (1) a mandatory requirement of the 2015 text is unmet or unverifiable; (2) the gap can produce a wrong
figure silently; (3) it blocks the charter's A1 equipment acceptance test. Files are named for the owner of the next
slice; none was edited here.

### Gap 1: the carrying-amount schedule is arithmetic without provenance; depreciation is never tied to the income statement (G-1)
- **Requirements:** R-13 (17.17, 5.11), R-20 (17.27-17.30), R-22 (17.31(d)), R-23 (17.31(e)); charter R1, R5, G4, G5.
- **Evidence:** `src/lib/preparation/equipment.ts:122-173` checks sums only; the "coverage" checkbox
  (`src/components/reporting/EquipmentPreparation.tsx:1042-1058`) is the sole completeness control; the schedule
  depreciation is never compared with `sci.depreciation_and_amortisation` or the by-function lines; disposals carry no
  proceeds, so the gain or loss (17.30) is never produced; the gross check (`equipmentRequirements.ts:90-123`) is two
  snapshots, so cost removed and accumulated depreciation eliminated on disposal are unchecked (ACCEPTANCE_CASES.md
  AC-06, AC-23).
- **Affected files:** `src/lib/preparation/equipment.ts`, `src/lib/preparation/equipmentRequirements.ts`,
  `src/components/reporting/EquipmentPreparation.tsx`, `src/lib/frameworkPacks/ifrsForSmes.ts` (schedule definition),
  and a successor to `supabase/migrations/20261019100000_fs_notes_and_schedules.sql` if the server is to tie the
  movement to the composed expense lines.

### Gap 2: useful lives, residual values and methods are free text, so the depreciation charge cannot be recomputed (G-2)
- **Requirements:** R-14 (17.18), R-16 (17.20), R-17 (17.21), R-18 (17.22-17.23); charter P2, R1 (estimates are
  provenance).
- **Evidence:** `EquipmentPolicy` in `equipment.ts:24-32` holds `usefulLife` and `residualValue` as strings;
  `policyDraft` (`:175-201`) accepts any three characters; `editorSchema.ts:14-15` stores them as text up to 2,000
  characters. A life entered as a tax class or a template reference is accepted (AC-35). No case in the suite computes
  a charge (AC-11, AC-12, AC-13).
- **Affected files:** `src/lib/preparation/equipment.ts`, `src/lib/preparation/editorSchema.ts`,
  `src/components/reporting/EquipmentPreparation.tsx` (step 4).

### Gap 3: the guided path is single-class and can replace a multi-class schedule (G-4)
- **Requirements:** R-01, R-21 (17.31 "for each class"), R-32 (4.11(a)).
- **Evidence:** `EquipmentPreparation.tsx:608-613` tells the user the save "replaces the entire PPE schedule";
  `:1292-1305` is a checkbox, not a block; `release/candidates/guided-equipment-r1/workpaper.sql:152-154` builds exactly
  one row. AC-27 shows a merged class passing every arithmetic check while losing the per-class disclosure.
- **Affected files:** `src/components/reporting/EquipmentPreparation.tsx`,
  `release/candidates/guided-equipment-r1/workpaper.sql`, `src/components/reporting/SchedulesView.tsx` (multi-class
  editor that already exists).

### Gap 4: conditional requirements have no follow-up questions and no register rows (G-3)
- **Requirements:** R-03, R-04, R-07, R-08, R-09, R-11, R-19, R-28, R-29, R-30, R-31 (spares, replacements, expensed
  costs and borrowing costs, dismantling, deferred payment, servicing, impairment assessment, finance leases, grants,
  events after the period, transition). The impairment assessment (17.24, 27.7) is mandatory every period, not
  conditional.
- **Evidence:** `equipmentRequirements.ts:9-80` has nine questions, none of which fires on these triggers; the pack
  (`ifrsForSmes.ts:69-164`) has no rows for 10.18, 20.13, 24.6, 27.32 or 35.13. PREPARATION_QUESTIONS.md section 4
  lists thirteen follow-ups with triggers and evidence.
- **Affected files:** `src/lib/preparation/equipmentRequirements.ts`; for new register rows,
  `src/lib/frameworkPacks/ifrsForSmes.ts` (pack version bump), `scripts/release/renderCoverageMatrix.mjs` output
  `docs/reporting/COVERAGE_IFRS_FOR_SMES.md`, and the seed of `fs_pack_requirements` in a successor migration.

### Gap 5: answers are a JSON workpaper, not reusable facts; the bridge is net-only and unlinked to restatements (G-5, G-6)
- **Requirements:** R-21, R-26 (8.5-8.7), R-22, R-27 (3.14, 10.21-10.23); charter L8, R4, R13.
- **Evidence:** `workpaper.sql:4-17` stores the whole editor as `payload jsonb`; the policy text is re-derived from it
  and inserted as free wording (`workpaper.sql:90-124`, `workpaperClient.ts:151-165`), so 8.6/8.7 cannot reuse the
  structured answers; `openingBridge` (`equipment.ts:42-119`) compares the net carrying amount only, and an adjustment
  that changes a comparative is never proposed through `fs_propose_restatement`
  (`supabase/migrations/20261020100000_fs_comparatives.sql:167`).
- **Affected files:** `release/candidates/guided-equipment-r1/workpaper.sql`, `src/lib/preparation/workpaperClient.ts`,
  `src/lib/preparation/equipment.ts`, consumers of `20261020100000_fs_comparatives.sql`.

Gap G-7 (revaluation does not stop at the unsupported OCI case) is real but ranks below these because `main` already
refuses to finalise an OCI case by name (`docs/reporting/NOTES_AND_SCHEDULES.md:53-58`).

## 3. Assessment of PR #207 against charter Step 0 and B5 (not a review of its code quality)

- The candidate matches its own description: preparation assistance, advisory arithmetic, no new authority. Its
  refusals (no balancing asset, no two-TB movement, blank is not zero, no defaulted life) are the right ones and are
  tested (`src/lib/preparation/equipment.test.ts`, `equipmentRequirements.test.ts`).
- For Step 0 it supplies facts-table rows C1-C13 (REQUIREMENTS_MATRIX.md section 1.2). Its CI status at a718230 was not
  checked here; its PR body says final CI was pending.
- For B5 it supplies nine candidate question texts with paragraph references and an explicit review-pending status
  (`equipmentRequirements.ts:7`). It does not supply register rows, fixtures with expected results, or named reviewers.
  The nine references were checked against the 2015 text: all cited paragraphs exist and say what the questions imply.
  Two precision notes: the `basis` question cites 17.15, 17.15A, 17.15B but the revaluation mechanics are 17.15C-17.15D;
  the `estimates` question cites 17.18, 17.19, 17.21 and omits 17.20 (when depreciation starts), which the method
  evidence text alludes to.
- Items the candidate's own RECORD.md marks as not delivered (`docs/release/guided-equipment-r1/RECORD.md:73-86`) are
  consistent with the gaps above; this document adds the depreciation tie-out, multi-class, estimate structure and
  conditional follow-ups as evidenced requirements rather than general "remaining work".

## 4. Unresolved questions (need an owner's or reviewer's answer)

1. **Accounting author and independent reviewer** for the equipment rows: not appointed; this document cannot appoint
   them (charter section 9).
2. **KPMG and Deloitte illustrative models:** not found. Searched the tracked repository (`git ls-files`), the working
   folder to depth 4 (including untracked `Claude outputs/` and `release-handoff-*` folders) and the shared notes folder
   (empty). Part D of the assignment is therefore **unresolved** (section 6 below gives only general cautions).
3. **Licensing for commercial embedding:** Module 17's terms permit free educational reproduction with conditions and
   state that inclusion in a commercial product needs a separate licence; the 2015 text in use is a third-party-hosted
   copy of an IFRS Foundation publication whose own terms were not checked in this session. Before any paragraph text
   (as opposed to paragraph numbers and original wording) is embedded in the product, the Foundation's terms must be
   confirmed (also flagged in `RECORD.md:119`).
4. **Hosted presence of the schedule functions:** inferred from `HOSTED_EVIDENCE_2026-10-21.md` (staged transports
   applied); not read back. The charter's FACTS TABLE `deployed` rows should be confirmed by the owner's read-only
   route before B1 closure.
5. **Should "revaluation" be selectable at all** while OCI is an unsupported reporting case on `main`? Product decision.
6. **Pack version bump:** adding rows for 10.18, 20.13, 24.6, 27.32 and 35.13 changes `IFRS_FOR_SMES_PACK_VERSION` and
   the seeded requirements; whether that belongs to the equipment slice or to a register slice is a scoping decision.
7. **Prior-period reconciliation:** 17.31(e) says the reconciliation need not be presented for prior periods, but 3.14
   requires comparatives for the 17.31(d) amounts. The server's `reconciled_opening_unverified` status is correct for
   the first; whether the opening gross and accumulated amounts must be bridged to the prior report (AC-23) is an
   accounting-author decision.

## 5. Recommended next implementation slice (proposal only)

Order follows the charter candidate's build order (B1 before B2; nothing beyond B2 until B1 is deployed), while noting
the charter is not adopted and existing repository controls govern.

1. **Review first, build second:** the accounting author re-reads every R-row against the pinned text and signs or
   amends it; the reviewer checks AC-01 to AC-35 expected results. Until then nothing here is content.
2. **B1 for #207** as its RECORD.md defines it (final candidate CI green, SQL promoted through the canonical migration
   process, installation authorised, browser acceptance). Not part of this document's scope.
3. **Equipment r2 content slice** (one PR, no new authority, SME 2015 only), in this order:
   - structured estimate fields per class (life as number + unit, residual as amount, method basis, the four 17.21
     prompts) with an advisory recomputed charge shown beside the entered depreciation movement (Gap 2; AC-11 to
     AC-13);
   - depreciation movement tied to the composed depreciation lines, and disposal proceeds with the computed gain or
     loss (Gap 1; AC-06);
   - multi-class guided path, refusing to replace a schedule that has more classes than the workpaper (Gap 3; AC-27);
   - the thirteen conditional follow-ups wired to the existing `fs_decide_requirement` mechanism where a pack row
     exists, recorded as answers where none does (Gap 4), with the mandatory impairment and events-after prompts always
     shown;
   - rewording per PREPARATION_QUESTIONS.md sections 2 and 3.
4. **Register slice** (separate PR): pack rows for 10.18, 20.13, 24.6, 27.32, 35.13 with citations verified against the
   pinned text, pack version bump, regenerated coverage matrix, golden fixture from AC-01/AC-06 signed by the reviewer.
5. **Answer-fact slice** (separate PR, needs schema design): structured answers as requirement-linked facts feeding
   8.5/8.6/8.7 and 17.31(a)-(c), and bridge adjustments linked to restatement proposals (Gap 5).

## 6. References assessment (assignment part D)

- **KPMG and Deloitte illustrative financial statements:** the files were not available (section 4, item 2). What follows
  is a general caution for any full-IFRS or jurisdiction-specific illustrative model and is not a description of those
  documents.
  - *Reusable presentation ideas:* a per-class columnar roll-forward with separate blocks for cost and accumulated
    depreciation; a table of classes with their basis, method and life range in the policy note; a separate column for
    assets under construction; cross-references between the equipment note, the borrowings note (security) and the
    commitments note. These are presentation conventions; the wording must be original.
  - *Treatments that must not be imported into the 2015 edition:* capitalised borrowing costs (IAS 23; the 2015 edition
    expenses all borrowing costs, 25.2); right-of-use assets and lease liabilities for all leases (IFRS 16; the 2015
    edition keeps the finance/operating split, Section 20); deducting a government grant from the asset (IAS 20 option;
    the 2015 edition recognises grants in income, 24.4); held-for-sale classification and measurement (IFRS 5; the 2015
    edition has only the 17.26 impairment indicator); mandatory comparative reconciliation (IAS 16; the 2015 edition
    says the reconciliation is not required for prior periods, 17.31); fair value hierarchy disclosures (IFRS 13);
    directors' report, audit report, companies-act or stock-exchange disclosures of any jurisdiction.
  - *Licensing:* illustrative publications by professional firms normally carry the firm's copyright and permit no
    reproduction without permission. Until the actual files and their terms are seen, assume no wording may be copied
    and no figure may be reused; use them, if at all, to compare structure.
- **IFRS Foundation Module 17 (2018-06):** educational staff material; its own terms allow reproduction for free
  educational use with acknowledgement, forbid use of the Foundation logo, and require a separate licence for inclusion
  in a commercial product; the right to use lapses when the module is withdrawn or updated. It is a guide to the 2015
  edition, not the Standard; cite the Standard.
- **The pinned 2015 text:** an IFRS Foundation publication hosted by a third party. Paragraph numbers and short
  paraphrases are used here; the Foundation's terms for reproducing the text itself must be confirmed before any
  verbatim embedding (unresolved, section 4 item 3).

## 7. What this handoff does not claim

- That any requirement is validated, that any report complies, or that PR #207 should be merged.
- That the hosted project matches `main` for the schedule functions beyond what the 2026-10-21 record states.
- That the expected results in ACCEPTANCE_CASES.md are correct for any real entity; they are arithmetic on synthetic
  inputs, awaiting the accounting author's signature.
- That the KPMG or Deloitte models were assessed; they were not located.
