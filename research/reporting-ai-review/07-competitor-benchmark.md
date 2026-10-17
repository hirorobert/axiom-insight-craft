# 07 — Competitor Benchmark (Draftworx, control.dev)

Official public sources only, accessed **2026-10-17**. Evidence tier is marked per claim:
**[M]** marketing claim · **[D]** documented workflow (vendor docs/feature pages) · **[O]**
independently observed (none here — neither product was run; no [O] claims are made). No valuation,
parity, superiority, or auditor-acceptance claim is made. No protected templates were copied.

## 7.1 Who they are (and how close to CFOClose's job)
- **Draftworx** — closest analog. Automated **IFRS / IFRS-SME / FRS** financial statements +
  assurance working papers, SA-origin, "20,000+ clients in 40+ countries" [M]. Job: TB → statutory
  statements + notes + working papers. Desktop license or pay-as-you-use cloud [D].
- **control.dev** — adjacent, not direct. **Multi-entity consolidation / live management
  reporting** over connected ledgers (P&L, BS, cash flow, dashboards), EU-hosted, ISO/IEC
  27001:2022 [M]. Job: keep a group's numbers live and drillable; **not** statutory-statement
  drafting from a raw TB. Most useful as a reference bar for AI-via-API and drill-down.

## 7.2 Customer-job comparison (official sources)

| Job | Draftworx [D] | control.dev [D] | CFOClose today (this repo) |
|---|---|---|---|
| Import | Direct from Pastel/Sage/QuickBooks/Xero/CaseWare + Excel [D] | Native syncs to accounting systems, ≥daily [D] | CSV/XLSX TB upload; deterministic column detection; no ledger connectors |
| Mapping | "Links" (category coding); **links carry forward annually** [D] | Map local accounts into group structure [D] | `account_mappings` (period-agnostic, deterministic reuse); **no bulk/grouped UI** |
| Evidence requests | Working-paper driven (assurance methodology) [D] | n/a (reads live ledger) [D] | Explicit evidence families + per-account cash-rollforward (World B, **gated off**) |
| Statements | SoFP, SoCI, SoCE, Cash Flow auto-generated from links [D] | P&L, BS, Cash Flow (management view, configurable) [D] | SFP + P&L live (float-summed, no comparatives); SOCIE/CF dark; full set exists in **gated** Engine B |
| Notes/policies | Auto-opens applicable policies + notes with balances [D] | n/a [D] | Deterministic disclosure notes (NoteSynth, live, TZ-specific); evidence-bound notes gated |
| Comparatives | Carried forward via links [D] | Monthly / YTD / point-in-time [D] | **Absent** in live renderer; present in gated Engine B |
| Review / sign-off | Digital signatures; print-to-PDF [D] | Not documented on reporting page | Certification + HESABU gates live; **role sign-off gate absent on legacy path (C-1)**; World-B publication gate strong but gated |
| Roll-forward | Links carry forward year-to-year [D] | Continuous (always live) [D] | Deterministic mapping reuse; governed-suggestion store dormant |
| Traceability | Statement ← link ← TB [D] | "Follow the number down to the transaction"; "open the accounts and transactions behind any figure" [D] | Provenance locators + drill-down exist in **gated** Engine B; live path has only a TB appendix |
| XBRL | **Embedded**; IFRS/IFRS-SME templates pre-linked to taxonomy, "5-minute submission" [M] | n/a [D] | `generate-xbrl` exists (Arelle) but UI-unreachable; silent framework default (C-3) |
| AI | None mentioned [D] | **MCP**: read-only finance-native API exposing numbers + the transactions behind them to AI tools [D] | Only narrative LLMs, none UI-reachable; ingestion/notes deterministic |

## 7.3 Table stakes (must reach to be credible for the TB→statements job)
1. **Full statement set with comparatives** from a reviewed TB (SoFP/SoCI/SoCE/Cash Flow) — both
   rivals do this; CFOClose's live path does not (it has the engine, gated).
2. **Auto-opened notes + accounting policies tied to balances** — Draftworx table stakes; CFOClose
   has a deterministic equivalent (NoteSynth) but not wired to the gated statement engine.
3. **Year-to-year carry-forward of mappings** — both carry forward; CFOClose does too (deterministic).
4. **Line → transaction drill-down** — both expose it; CFOClose only in the gated engine.
5. **Credible review/sign-off with role control** — Draftworx has signatures; CFOClose's live
   role gate is missing (C-1).

## 7.4 Defer (not required for first credible release)
- Multi-entity **consolidation / FX / eliminations** (control.dev's core) — out of CFOClose's
  single-entity statutory job; defer.
- Ledger **connectors** (Pastel/Sage/Xero) — valuable later; the controlled CSV/XLSX intake is a
  defensible v1 given the deterministic provenance discipline.
- Desktop client — cloud-only is fine.

## 7.5 Three credible differentiation opportunities (and a test that would demonstrate each)
1. **Evidence-truthful statements (refuse-don't-fabricate).** CFOClose already encodes null≠zero,
   no silent defaults, `EVIDENCE_GAP` as a first-class state, and a cash rollforward that fails
   closed. Neither rival advertises explicit evidence-gap refusal. *Test:* on fixtures F4/F8/F10
   (`06`), show CFOClose surfaces the gap where a link-driven tool would present a filled number.
2. **Deterministic, reproducible output with provenance drill-down + snapshot replay.** Engine B
   produces a content-hashed report that restores byte-for-byte or reports `DIVERGED`. *Test:*
   regenerate an approved report and prove identical content hash; open any line to its TB rows.
3. **Tanzania-statutory depth as a governed jurisdiction pack** (ITA Cap.332 / FA2026 / TRA /
   IPSAS-accrual + GFRS public-sector), kept independent of the taxonomy layer. *Test:* produce a
   TZ IPSAS-accrual set with budget-vs-actual where the generic rivals offer only IFRS/SME.

## 7.6 Honest gap to close first
The differentiators are real **but mostly live behind the feature gate**. Against a shipping rival,
CFOClose's *current live* output (SFP + P&L, no comparatives, float totals, boilerplate notes) is
below table stakes. The benchmark's clearest implication: **activate Engine B** before competing on
the evidence-truthfulness story.

## Sources
- [Draftworx — home](https://draftworx.com/) · [Draftworx — Features](https://draftworx.com/features/features.html) · [Draftworx on Sage Marketplace (ZA)](https://za-marketplace.sage.com/en-za/apps/74683/draftworx/features)
- [Control.dev — home](https://www.control.dev/) · [Control.dev — Reporting](https://www.control.dev/reporting/) · [Control.dev — MCP for financial analysis](https://www.control.dev/mcp/)
