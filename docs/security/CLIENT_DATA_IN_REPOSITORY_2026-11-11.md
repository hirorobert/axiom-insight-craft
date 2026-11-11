# Client-derived trial balance in the repository — containment record

**Opened:** 2026-11-11. **Status:** current tree contained by this change (unmerged); history, hosted copies and
notification are **open owner decisions**. This record names no client and reproduces no figure. The identity of
the client, the file's fingerprint and the full exposure list are held outside the repository by the owner.

## 1. What happened

A comma-separated trial balance derived from a real client's financial statements was committed at the repository
root on 2026-06-30 and stayed on `main` until this change. Historical prompt documents, two Edge Function comments, a
test name and two applied migrations also named the client, and some quoted its figures.

## 2. Classification

| Question | Finding | Basis |
|---|---|---|
| Kind of data | Confidential client financial information: account balances of a named private limited company, its lenders and its tax obligations | File structure read locally (names of columns and accounts only) |
| Natural-person data in the file | None found: account names are generic ledger captions; the lenders named are institutions | Account-name column reviewed locally |
| Natural-person or system identifiers elsewhere | An internal user UUID and a company UUID appear in comments of an applied migration | `supabase/migrations/20260626200000_*`, `20260627110000_*` |
| Professional duty engaged | Client confidentiality of a professional accountant | Owner and counsel to confirm the applicable code |
| Statutory personal-data breach | Not established by this record; depends on whether any data relates to an identified natural person and on counsel's reading of the applicable law | Counsel to decide |

## 3. Exposure scope (facts the repository can show)

| Location | State |
|---|---|
| GitHub repository | Private, one collaborator (the owner, admin), no forks, no deploy keys (read 2026-11-11) |
| Git history | The file exists from 2026-06-30 onward and is present at the tip of about 289 remote branches; pull-request refs retain it as well |
| Production frontend bundle | The client's name does not appear in the live entry bundle or any lazy chunk (checked 2026-11-11) |
| Deployed Edge Functions | Two engine functions carried the name and figures in comments; their deployed copies keep them until redeployed |
| Applied migrations | Two applied migrations name the client in comments; they are SHA-256 pinned to the hosted journal and cannot be edited without breaking release parity |
| Hosted staging | The manual-only staging job uploaded the file to the hosted staging project; 29 manual CI runs between 2026-09-22 and 2026-10-15 could have done so; the scripts' cleanup preserves append-only evidence, so copies may remain |
| Third-party tools with repository access | Lovable (GitHub sync), and AI coding agents used on this repository; their retention is governed by their own terms |
| Production database | Historical design notes describe uploading the file to production for a dry run; whether that row exists cannot be read from here |

## 4. Containment done in this change

- The file is removed from the current tree.
- The two guarded staging scripts now upload an independently invented, balanced fixture (`scripts/fixtures/synthetic-sme-tb-2025.csv`).
- The name and figures are removed from engine comments, a test name, the gallery isolation check and the historical prompt documents.
- `scripts/ci/clientDataGuard.mjs` (run by `src/lib/__tests__/clientDataGuard.test.ts` in the release gate) fails if the client's name or any of 43 of its amounts reappears, using salted hashes only. Two other client-derived fixtures, owned by draft PR #171, are listed as tracked exceptions that may only shrink.

## 5. Not done — owner decisions, in recommended order

1. **Preserve evidence first.** Before any history rewrite, export the affected commits to encrypted storage the owner controls, and keep the fingerprint with the restricted record.
2. **Decide on notification** with counsel: the client, and any regulator if counsel finds personal data was involved.
3. **Hosted staging:** list and remove any uploads of the file from the staging project's storage and tables.
4. **Production:** confirm whether the client's company and trial balance exist in production, and whether that use was authorised by the client.
5. **History:** decide whether to rewrite history (for example `git filter-repo` across every branch, then a force push, then a GitHub Support request to purge cached views and pull-request refs). Doing so invalidates every open branch and must be coordinated with Lovable's sync. The two applied migrations need a separate decision because the hosted journal pins their exact bytes.
6. **Third parties:** ask Lovable and the AI vendors used on the repository about retention or deletion of synced copies.
7. **Redeploy** the two engine functions so the deployed comments are replaced (both are withheld from customers).
