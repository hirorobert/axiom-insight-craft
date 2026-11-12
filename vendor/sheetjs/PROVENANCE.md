# SheetJS 0.20.3 — vendored copy (provenance record)

SheetJS (`xlsx`) is the spreadsheet library behind the trial-balance reader (`supabase/functions/_shared/tbSource.ts`, run by
`process-trial-balance`, `trial-balance-layout` and `layout-assist`), the client-side Excel export and the test corpus.
SheetJS stopped publishing to the npm registry after 0.18.5 (`https://registry.npmjs.org/xlsx/latest` still answers 0.18.5 on
2026-11-11). Every later release, including every release that fixes CVE-2023-30533 (prototype pollution, `< 0.19.3`) and
CVE-2024-22363 (ReDoS, `< 0.20.2`), is published only on SheetJS's own CDN. SheetJS documents vendoring the release tarball as
a supported installation method.

So that no install and no Edge Function run fetches code from `cdn.sheetjs.com` (or any host other than the npm registry the
rest of the lockfile already uses), the release is committed here, byte for byte, and pinned.

## What is vendored

| file in this repository | what it is | bytes | SHA-256 |
|---|---|---|---|
| `vendor/sheetjs/xlsx-0.20.3.tgz` | the official release tarball, unmodified | 2,409,319 | `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8` |
| `vendor/sheetjs/LICENSE` | `package/LICENSE` from the tarball (Apache License 2.0) | 11,355 | `4d2a38ac35cda06a555c84074a819d413339cd3691b822cae50f8f322fe01f64` |
| `supabase/functions/_shared/vendor/sheetjs-0.20.3/xlsx.mjs` | `package/xlsx.mjs` from the tarball: the ESM build the Edge Functions import (it imports nothing) | 1,008,308 | `1a0fb062ee9781b13f6687371b202aaefc53b6ce55b530c027e01f9c087b77db` |
| `supabase/functions/_shared/vendor/sheetjs-0.20.3/types/index.d.ts` | `package/types/index.d.ts` from the tarball: type declarations only, named by `// @deno-types` so `deno check` keeps `XLSX.WorkBook` and `sheet_to_json<T>`; never executed | 27,917 | `191e4e6aceae3602aa3a1e9a6bc0e98821d6d5fb787e2bc16e250439482bddb6` |
| `supabase/functions/_shared/vendor/sheetjs-0.20.3/LICENSE` | `package/LICENSE` again, beside the code the functions ship | 11,355 | `4d2a38ac35cda06a555c84074a819d413339cd3691b822cae50f8f322fe01f64` |

Tarball SHA-512: hex `a0b0eade3c3b01c2ea2961f60210a9553665f267fa5f661178ff8d7a1d12254cd5fc1759623b61f78b46e6da22301d4f3eb62dc4e09f6a850292fb6e1fedc024`,
integrity form `sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==` (the value `bun.lock`
records for `xlsx`).

- Package: `xlsx`, version `0.20.3`, licence `Apache-2.0` (`package/package.json`). No `dependencies`, no
  `optionalDependencies`, no `peerDependencies`, and no install lifecycle script (`preinstall`/`install`/`postinstall`); its
  scripts are `pretest`, `test`, `pretest-only`, `tests-only`, `build`, `lint`, `dtslint`, none of which an install runs.
- `.gitattributes` stores these files without end-of-line conversion (`*.tgz binary`, `vendor/sheetjs/LICENSE -text`,
  `supabase/functions/_shared/vendor/** -text`), so the hashes are the same in a Windows checkout, a Linux checkout and
  `git archive`.

## Where it came from

- Source URL: `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (operated by SheetJS LLC, the publisher).
- Fetched once, on 2026-11-11 at 15:10:10 UTC, into a new empty directory, as data only: nothing in it was executed, built or
  installed from that directory. Response: HTTP 200, `Content-Length: 2409319`.

## What was cross-checked (2026-11-11)

1. **Same bytes as the earlier download recorded in this PR.** The SHA-512 above equals the integrity `bun.lock` recorded in
   commit `be4df8f` (an earlier download of the same URL, by the first revision of this PR), and the SHA-256 equals the value
   that revision's PR description recorded. This shows the CDN served identical bytes twice; it is not independent provenance.
2. **Every file in the tarball equals the tagged release source.** All 26 files under `package/` were compared byte for byte
   (SHA-256) with the same paths at tag `v0.20.3` of `https://git.sheetjs.com/sheetjs/sheetjs` (tag object
   `f30a4dfd4c994f2c1ce57f6cb0281917bca76e7f`, commit `8a7cfd47bde8258c0d91df6a737bf0136699cdf8`, tagged 2024-07-18), read through
   that server's API `GET /api/v1/repos/sheetjs/sheetjs/raw/<path>?ref=v0.20.3`. **26 of 26 identical**, including `xlsx.mjs`,
   `types/index.d.ts`, `LICENSE` and `package.json`. (The web `raw/tag/...` route redirects to a login page; the API route
   does not.)
3. **The vendored files equal the tarball's copies.** `xlsx.mjs`, `types/index.d.ts` and both `LICENSE` files are the
   tarball's `package/` files unchanged. `scripts/ci/assertVendoredDependencies.mjs` re-checks this on every CI run.
4. The tarball's `package/xlsx.mjs` has no `import` statement and no dynamic `import()`, so nothing else needs vendoring for
   the functions (`scripts/release/functionClosure.mjs` finds no further file and no remote specifier in it).

## What was NOT verified

- **No signature.** SheetJS publishes no signature and no separate checksum file for the tarball, and the API reported no
  verification data for the tag. The hashes are what was downloaded, cross-checked against the tagged source.
- **Same trust root.** `cdn.sheetjs.com` and `git.sheetjs.com` are both operated by SheetJS LLC. A compromise of the
  publisher's infrastructure before 2026-11-11 that changed both consistently would not be detected by check 2.
- **The build was not reproduced.** `xlsx.mjs` is a generated file committed in the tag; it was not rebuilt from the `bits/`
  sources, so its correspondence to the readable source is the publisher's, not ours.
- **No code review of the 1 MB library** beyond the facts above. CVE coverage rests on the advisories' fixed versions and on
  `src/lib/ingestion/sheetjsPrototypePollution.test.ts` (CVE-2023-30533 reproduced on 0.18.5, refused on 0.20.3);
  CVE-2024-22363 (ReDoS) was not reproduced.
- Not compared with the npm registry: there is no 0.20.3 there to compare with.

## How to re-verify

- Offline, every CI run: `node scripts/ci/assertVendoredDependencies.mjs` checks the pinned SHA-256 of every vendored file,
  that each Deno file equals its copy inside the committed tarball, that `bun.lock`'s integrity equals the tarball's SHA-512,
  and that no `cdn.sheetjs.com` (or other non-registry) URL is named by `package.json`, `bun.lock`, `deno.lock`, an import
  map, a `deno.json`, the CI workflow or any Deno import.
- Online, by hand (never in CI): `node scripts/vendor/reverifySheetjs.mjs` downloads the tarball from the source URL and the
  tagged files from `git.sheetjs.com` into memory (nothing is written or executed) and compares their hashes with the pins.
  Exit 0 means everything matched. Runs so far: 2026-11-11 15:34 UTC, exit 0 (source tarball equal to the committed one and
  the pins; 26 of 26 packaged files equal to tag `v0.20.3`).
- Manually, with standard tools: `curl -sSLo /tmp/x.tgz https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz && sha256sum /tmp/x.tgz`
  must print the SHA-256 above.

## How an upgrade happens

Dependabot cannot watch this dependency (it is not on a registry Dependabot reads; `package.json` names a local file), and
`bun update` will not move it. An upgrade is a reviewed pull request that:

1. downloads the new tarball once, into an empty directory, as data;
2. replaces `vendor/sheetjs/xlsx-<version>.tgz`, both `LICENSE` copies and the files under
   `supabase/functions/_shared/vendor/sheetjs-<version>/` (renaming the directory), and the import paths in the Edge Functions
   and `scripts/bench/tbUploadPolicyDenoProbe.ts`;
3. updates the pins in `scripts/ci/assertVendoredDependencies.mjs`, `scripts/vendor/reverifySheetjs.mjs` and this file, with
   the same cross-checks recorded again;
4. re-pins every Edge Function closure that includes the Deno file, from `git archive HEAD` bytes;
5. runs the reader suites, the characterization corpus and the prototype-pollution test, and lists the functions to redeploy.

Advisories for SheetJS are watched by hand: see `docs/security/DEPENDENCY_ADVISORY_WATCH.md`.
