# `trial-balance-storage-cleanup`: deployment reconciliation

**Conclusion.** The deployed version's identity has **not** been established. Under the release rule ("reuse a
verified compatible deployment; redeploy only if identity or required behaviour cannot be established"), a redeploy is
**required** unless the read-only check below proves otherwise.

It gates **only** `TWO_PERIOD_INTAKE_ENABLED`. It does not gate the reporting release. Nothing hosted has been
changed.

## Evidence

| Item | Status |
|---|---|
| Required closure | `04ebf148992f85b0b224215bfacb36bcd6a1342f822346c0e018594bfc410b7f`. Files: `trial-balance-storage-cleanup/index.ts` (`e0c33ee8…`, 4,758 B) and `_shared/storageCleanup.ts` (`b00724a2…`, 6,960 B). Main since `80384d1` (PR #76). |
| Known older closure | `e47b381850dc13a4101613a799233313b3400df4308a6f28f91650b23ca0d7df`. Main before `80384d1` (PR #32). It differs only in `_shared/storageCleanup.ts` (`13198c68…`): three lines that map the server's `source_shared` completion. Unknown to it, `source_shared` answers **500 `completion_failed`** and deletes nothing (it fails closed). |
| Lovable close-out (2026-10-08) | REPORTED: "reused the earlier deployment"; not redeployed. Installed bundle fingerprint: **NOT AVAILABLE**. |
| Behaviour probe without data | **Not distinguishing.** An unknown operation id answers 404 `stale_operation` in both versions. Only a real shared-source discard produces `source_shared`, and that needs hosted data changes. |
| Today's exposure | None. There are 0 shared-source uploads, and the two-year intake gate is off. |

## Read-only identity check (owner, hosted read)

```bash
supabase functions download trial-balance-storage-cleanup --project-ref bvyivmmfjejbmqoydezk
node scripts/release/verifyDeployedClosure.mjs trial-balance-storage-cleanup <directory it wrote>
```

Run the download in an empty scratch directory. The verifier hashes the downloaded files, using exactly the closure
rule of `functionClosure.mjs`, and executes nothing. It gives one of three verdicts:

| Verdict | Exit | Meaning | Action |
|---|---|---|---|
| `REQUIRED` | 0 | The deployed bundle is the required closure | Reuse it; no redeploy. |
| `KNOWN_OLDER` | 1 | The pre-#76 bundle | Redeploy. |
| `UNKNOWN` | 1 | Anything else | Redeploy. |

The verifier is tested in `src/lib/__tests__/verifyDeployedClosure.test.ts`: the current sources give `REQUIRED`, the
pre-#76 sources give `KNOWN_OLDER`, and a one-byte change gives `UNKNOWN`.

## Redeploy (only if the check does not return REQUIRED; needs owner authorization)

```bash
supabase functions deploy trial-balance-storage-cleanup --project-ref bvyivmmfjejbmqoydezk
```

Deploy from a checkout whose `node scripts/release/functionClosure.mjs trial-balance-storage-cleanup` prints closure
`04ebf148…0b7f`. Then repeat the download-and-verify step and expect `REQUIRED`.

## Then, and only then

Before `TWO_PERIOD_INTAKE_ENABLED` is enabled, observe `source_shared` once on a demo shared-source discard on
staging. That step changes hosted data, so it needs its own authorization.
