# Dependency advisory watch

Most JavaScript dependencies come from the npm registry through `bun.lock`, and GitHub Dependabot raises an alert when one of
them has a published advisory. A dependency that is vendored into the repository is outside that watch: Dependabot does not
read a local tarball, and `bun update` does not move it. Each such dependency is listed here with the manual watch that
replaces Dependabot for it.

## 2026-11-11 — SheetJS (`xlsx`) 0.20.3, vendored

- **What:** `vendor/sheetjs/xlsx-0.20.3.tgz` (the npm and test side) and
  `supabase/functions/_shared/vendor/sheetjs-0.20.3/xlsx.mjs` (the copy shipped inside `process-trial-balance`,
  `trial-balance-layout` and `layout-assist`). Provenance, hashes and the upgrade procedure: `vendor/sheetjs/PROVENANCE.md`.
  Pins enforced by `scripts/ci/assertVendoredDependencies.mjs` on every CI run.
- **Why vendored:** SheetJS publishes releases after 0.18.5 only on `cdn.sheetjs.com`, and the owner does not accept an
  externally hosted spreadsheet dependency fetched at install or run time. 0.20.3 fixes CVE-2023-30533 (prototype pollution,
  affects `< 0.19.3`; reproduced through the trial-balance reader on 0.18.5 by
  `src/lib/ingestion/sheetjsPrototypePollution.test.ts`) and CVE-2024-22363 (ReDoS, affects `< 0.20.2`; not reproduced).
- **Dependabot:** the two open alerts on `xlsx` 0.18.5 (alerts #1 and #2) close once this change reaches `main`. After that,
  Dependabot will **not** report new SheetJS advisories, because `package.json` names a local file.
- **Manual watch (owner: whoever owns dependency security; not yet assigned):** at least monthly, and before every release
  that ships one of the three functions or the client export:
  1. read the SheetJS advisories on GitHub's advisory database (`https://github.com/advisories?query=sheetjs`, ecosystem npm,
     package `xlsx`) and the release list `https://cdn.sheetjs.com/xlsx.lst`;
  2. if an advisory affects 0.20.3, or a newer release fixes a security issue, open a reviewed upgrade PR as
     `vendor/sheetjs/PROVENANCE.md` describes (new tarball, new Deno copy, new pins, closures re-pinned, the three functions
     redeployed);
  3. record the date and result of each check below.

| date | checked by | result |
|---|---|---|
| 2026-11-11 | PR #271 (vendoring) | 0.20.3 is the newest release on `xlsx.lst`. GitHub advisory database (`gh api "/advisories?ecosystem=npm&affects=xlsx"`): 5 advisories, the newest range `< 0.20.2` (CVE-2024-22363); none affects 0.20.3 |
