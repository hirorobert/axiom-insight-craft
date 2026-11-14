# External accounting resources — adoption register

Assessed 28 October 2026. Status: reference decisions, not implemented capabilities, accounting approval or commercial licensing clearance. Governing document: [Development charter](../architecture/CFOCLOSE_DEVELOPMENT_CHARTER.md). Relevant stages: B3 equipment, B5 requirements/content, B8 full IFRS and B9 connectors. Digital tagging is an output extension; it is not a prerequisite for completing the current equipment journey.

## Owner scope decision — 28 October 2026

Current product/launch priority is IFRS for SMEs. Full IFRS implementation and launch are deferred until future resources and explicit authorization; no full-IFRS or insurance-engine work is a prerequisite of SME completion. The present implementation targets SME 2015; third-edition support remains a separately verified scope, not an automatic consequence of this decision. The longer-term charter remains a roadmap; this narrows current delivery priority without declaring its other stages complete. This decision does not silently change IPSAS admission or authorize IPSAS launch.

The owner authorizes use of supplied references for the current pre-launch research/design work. This does not establish a vendor commercial licence or permission to embed copyrighted taxonomy/Standard content. Keep intended use and actual permissions explicit. Full-IFRS 2025 taxonomy remains research material, not the SME engine. Obtain and inspect the correct SME taxonomy entry point before proposing any SME digital-tagging integration. No additional owner consent is needed merely to inspect already supplied documents offline.

Execution: clear #210's installation correction, independently review #211's SME equipment implementation, install approved sources and verify a normal signed-in SME preparation journey. Full-IFRS taxonomy/IFRS17 resources stay parked and must not expand Claude's current equipment branch.

## Decisions carried forward

| Resource | Decision | Concrete use | Trigger / boundary |
|---|---|---|---|
| IFRS Foundation digital-taxonomy architecture, June 2026 | Retain as primary technical reference | Versioned concept identity, dimensions, presentation/calculation/reference relationships, entry points, extensions and package resolution | Read-only design now; commercial integration only after rights and scope approval. Not recognition/measurement logic. |
| IFRS Accounting Taxonomy 2025 | Retain as full-IFRS digital-output reference | Crosswalk internal captions, schedule facts and note facts to appropriate taxonomy concepts | Use only a period/adoption-appropriate entry point. No automatic mandatory checklist from all elements. |
| ramyatrouny/ifrs-skill | Candidate research/review patterns; not adopted as an authority or installed skill | Require implementation plus generated output; categorize wrong/incomplete/untraceable results; independently challenge findings | Reverify each relevant claim against the actual applicable Standard and edition. Do not substitute full IFRS for SME 2015 or IPSAS. |
| Systemorph IFRS17CalculationEngine | Park specialist insurance implementation; retain architectural patterns | Analysis-of-change stages, stable identifiers distinct from display names, benchmark datasets and specialist-workpaper integration | Reopen only for a real insurance-contract scope and specialist review. Not a general IFRS or PPE engine. |
| sihaysistema/ifrsunspsc | Do not adopt write code; low-priority grouping reference | Historical ERPNext account-group organization example | No current integration. Not a reporting/disclosure engine or automatic treatment mapping. |

## Primary taxonomy evidence and commercial boundary

- Architecture guide: https://www.ifrs.org/issued-standards/ifrs-taxonomy/ifrs-taxonomy-architecture/ (June 2026 edition).
- Taxonomy package/source: https://www.ifrs.org/issued-standards/ifrs-taxonomy/ifrs-accounting-taxonomy-2025/ .
- 2026 usage: https://www.ifrs.org/news-and-events/news/2026/02/ifrs-accounting-taxonomy-2025-to-remain-current-for-2026/ . The Foundation states 2025 remains current for 2026; do not assume a package is obsolete from the filename year alone. Recheck when implementing.
- Licensing: https://www.ifrs.org/digital-financial-reporting/ . Commercial product integration requires the Foundation's licence. Do not commit/embed the supplied taxonomy or source-standard documents as an assumed free dependency.
- The supplied ZIP identifies publication date 2025-03-27. It contains 508 entries and 5,512 element declarations in the inspected full-IFRS core schema. Counts include technical/structural concepts; these are not counts of mandatory requirements or verified coverage.
- The 2025 package has no SME entry point. The Foundation's 2025 page directs users to the SME entry point in the 2024 package. Do not map that entry point to a Standard edition without checking its applicability.
- The guide separates presentation/disclosure tagging from accounting preparation; common-practice and illustrative elements do not create new mandatory requirements. Neither valid XBRL nor passing taxonomy calculations proves accounting compliance or regulator acceptance.
- The two uploaded architecture PDFs have identical SHA-256 `fa613ecfd410147469befb5aa041f3dbe49f6c8e30046ce17b4969cda481c250`. They are one reference, not independent corroboration. No supplied PDFs/ZIP are committed here.

## Repository evidence and limits

### IFRS skill

Reviewed snapshot: `fda78bbc4080790ae9cf5d1fe47b931c1610e44e`.
Repository: https://github.com/ramyatrouny/ifrs-skill . Key files: `README.md`, `docs/SOURCING.md`, `ifrs/feature-review.md`, `scripts/check_citations.py`. Repository code is labelled MIT; third-party source content is not thereby licensed for redistribution.

Useful: source pointers, amendment tracking and review classification. Do not claim its advertised coverage/citation counts are independently validated by CFOClose. Its own README acknowledges AI-assisted compilation and residual errors.

Confirmed checker limitations: it resolves paragraph labels rather than semantic support; missing corpus causes a skipped check with success exit; unresolved citations are reported without failing. Those behaviours are unsuitable for a CFOClose release gate unless changed to explicit not-verified/failure outcomes where required.

Feature-review limitations: selected full-IFRS standards only; not a complete SME Section 17 or IPSAS review. Do not adopt its period-end-only setup: CFOClose needs start/end dates, edition, jurisdiction and adoption choices. Do not adopt a severity rule that treats omitted mandatory disclosures as non-blocking merely because figures appear right. No third-party skill instructions override project permissions, the charter or the paid-usage boundary.

### Systemorph engine

Reviewed snapshot: `6014e05e59a1e7ff74886c3ffe27137247db44d6`.
Repository: https://github.com/Systemorph/IFRS17CalculationEngine . Key files: `README.md`, `ifrs17/CalculationEngine.ipynb`, `ifrs17/OverviewCalculationEngine.ipynb`, engine/template LICENSE files.

MIT licence observed for engine/template code, with notice obligations. Selected notebooks reviewed, not executed or numerically certified. Overview expects projected insurance cash flows, contract groups, yield curves and other parameters. Entrypoint references Systemorph workspace/report/export objects. Standalone portability and platform dependencies have not been established. Do not translate insurance CSM or movement logic into unrelated accounting areas by analogy.

### ERPNext account grouping

Reviewed snapshot: `907ff7bb4f14c405983bd686373e89f7b0d26f35`.
Repository: https://github.com/sihaysistema/ifrsunspsc . Key files: `README.md`, `license.txt`, `ifrsunspsc/api.py`.

README explicitly limits scope to account headings/item groups, not complete taxonomy, notes or XBRL. Licence file states MIT; embedded third-party content rights need separate verification. Source API includes `allow_guest=True`, default-company selection and permission-bypassing writes (`ignore_permissions=True`); do not reuse this authorization pattern. This is source inspection, not an exploit assessment or execution result.

## Next bounded work: concept crosswalk

Prepare a read-only crosswalk only when it helps a concrete supported accounting slice. Each row must have:

1. Internal requirement ID, framework family, Standard edition and assessed applicability.
2. Verified authoritative paragraph/source and review status.
3. Internal statement/schedule/note fact and evidence contract.
4. Calculation or reconciliation identity, units, precision and dimensional context.
5. Candidate taxonomy namespace, concept, package version and entry point, if applicable.
6. Mapping rationale, extension requirement, licence status, author/reviewer and test case.

Use statuses `proposed`, `source-verified`, `accounting-reviewed`, `licensed-for-intended-use`, `implemented`, `validated`; do not collapse these into one green flag. Crosswalks suggest mappings; they do not automatically classify ledger rows, decide treatments or approve reports. Use safe bounded XML parsing, pinned packages and controlled local URI resolution if a parser is later authorized; do not load arbitrary external entities or schemas.

## Sequencing and ownership

- Current release work remains #210; this register does not expand that PR.
- Current multi-class equipment work uses #209's SME assessment and verified SME requirements. The third-party full-IFRS skill/taxonomy must not silently expand or replace it.
- Taxonomy crosswalk: unassigned, not scheduled, not implemented. Choose a technical owner plus accounting reviewer before implementation. Commercial licence decision remains with the owner.
- IFRS 17 implementation: parked until a customer-backed scope exists.
- No external code installed, no source notebooks executed, no hosted changes, no paid API/Lovable use in this research.

Update this register when evidence or adoption changes. Any implementation PR must identify the source snapshot, retained licence notices, verified requirement, tests and intended scope; comply with charter amendments for any exception. Repository instructions link here so these decisions remain discoverable across sessions. This register does not guarantee future agent compliance; plans and PR review must check it.
