# Phase 5 — Accounting interpretation & controlled reuse (research)

Research only. Isolated prototype + synthetic proofs. **No production code, migration, registry, lockfile, entitlement,
payment or deployment is changed.** Everything here is under `research/phase5/**`.

## What this is
A deterministic prototype that, for an unfamiliar trial balance, recognises structure, proposes **grouped** account treatments
(not hundreds of individual approvals, and no blanket "Accept all"), surfaces consequential uncertainty, obtains explicit
reasoned acceptance per group, reuses compatible approved decisions on repeat uploads, and reopens affected decisions when
identity or meaning changes — all reusing the existing production contracts (no new database).

## Layout
```
research/phase5/
  INTERFACE-PROPOSAL.md   minimum compatible interfaces, mapped to existing contracts
  DECISION.md             deterministic vs AI-assisted vs hybrid; smallest defensible architecture; limits; evidence reqs
  HANDOFF.md              branch, implementation commit, tests, dependencies, proposed Phase 6 scope
  prototype/
    util.mjs              canonical JSON + sha256 (node built-ins only)
    layer1_structure.mjs  export-structure recognition (COLUMN_MATCHERS / dimensions)
    layer2_identity.mjs   account_key = COALESCE(code, normalized name)  (exact production rule)
    layer3_meaning.mjs    accounting meaning + relationships + uncertainty (deterministic; MUSE cases = scoped knowledge)
    layer4_treatment.mjs  reporting treatment (account_mappings enums) + grouping
    layer5_evidence.mjs   evidence sufficiency per output (trust tier; never-plug)
    lifecycle.mjs         review summary, grouped acceptance, reuse, invalidation/reopen, refusals
  tests/
    phase5.test.mjs       runnable synthetic proof (29 checks; invented accounts/amounts only)
```

## Run
```
node research/phase5/tests/phase5.test.mjs
```
No dependencies beyond the Node standard library. No network, no model, no private data. Simulated behaviour is labelled.

## Privacy
All accounts and amounts are independently invented. `cfoclose_tb_fixtures.zip` is NOT used (it reused source amounts). No
private workbook, source figure, or screenshot is committed; nothing is sent to a model.
