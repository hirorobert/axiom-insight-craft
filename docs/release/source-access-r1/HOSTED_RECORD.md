# Source-access repairs: hosted install record (2026-10-31)

This records what the owner-authorised install put on the hosted database and what was deployed, as reported by the installing agent
(Lovable) and checked by read-only queries and unauthenticated probes made independently of it. It is a record, not an acceptance:
independent review of the transport, accounting acceptance and customer visibility are separate gates and are not claimed here.

## Database (hosted journal ids 98 and 99, Drizzle 0097 and 0098)

| Hosted id | Drizzle tag | Step | Journal hash |
|---|---|---|---|
| 98 | `0097_source_access_staged_transport` | bootstrap (private schema `cfoclose_source_access_release`) | `f5c3ad23b687834910c65276e6631544a21c2ed19cd57c3965ff003cadd9e1f6` = the reviewed file (`9d95500f...e415`) plus the migrator's one final LF |
| 99 | `0098_source_access_1_staged_apply` | apply of `20261211100000_source_access_authority_repairs.sql` | `d31be75cbcd95962dda56aaea235521668780a8b7cd5a24643bf640c21f4f287` = the reviewed file exactly (16,403 B) |

Unlike hosted id 97, nothing drifted: the SQL in the approval prompt for entry 99 was hashed (in the page) against the reviewed file before it was
approved and matched byte for byte. The staged source was loaded through the transport's own byte/hash pin (25,437 B `be582111...b344`), checked
exact and unconsumed before the apply, and consumed exactly once by it.

Observed afterwards by a separate read-only query: journal head 99 (`d31be75c`); `public.trial_balance_source_download_events` exists with row
security on and is empty; trigger `trg_firm_members_revoke_workspace_grants` exists; `decide_trial_balance_source_download_issuance` and
`record_trial_balance_source_download_denial` are executable by `service_role` only; the two trigger functions by nobody; `anon` cannot read the
table; one consumed staging row and one `applied` event; publication bindings still 2, pack issuances still 0. The apply itself enforces the
fine-grained table and function privileges and the preserved-record baseline (existing grants and memberships included) in the same transaction.

## Edge function

`trial-balance-source-download` was deployed after the database objects existed (and not before, because it calls them). Its repository source was
verified before deploy: `index.ts` 5,359 B `01f02776...cbc1`, `_shared/sourceDownload.ts` 16,041 B `678489ce...8ff2`. Unauthenticated probes, made
with random identifiers and no credentials so that no download event could be written: OPTIONS 200; GET 405; POST with an empty body 400
`invalid_request` (the body shape is validated before authentication, by design); POST with a well-formed body and no credentials, or with a
garbage bearer token, 401 `unauthenticated`. No authenticated call was made and no download event exists.

## What this does NOT establish

- No end-to-end download was performed: a real signed link for a real upload, the 60-second link, the freshness margin and the audit rows have not
  been exercised on the hosted database. That needs an authenticated test with the owner's consent.
- The frontend was not published. Whether a customer can reach the download button is governed by the application's own flags, not by this install.
- Independent review of the transport (#231) happened after, not before, the install, by the owner's decision.
- Still open from the design: who besides the workspace owner may read the audit rows, retention and deletion, whether other-company or
  unknown-upload attempts are recorded, the clock-skew policy and whether the 5 s margin is right, and whether delivery evidence is wanted.
- Hosted id 97 (statement review) remains the one-space variant recorded in `docs/release/ipsas-accrual-chain-r1/HOSTED_RECORD.md`, pending the
  reviewer's decision.
