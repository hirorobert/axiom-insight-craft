// The release scans must detect what they claim to detect, and must never echo a secret value.
// Secret-shaped fixtures are assembled at run time so this file itself contains no credential-shaped literal.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script without types
import { AUTHORIZED, authorizeChangedPaths, findNulFiles, findSecrets, paymentSurfaceChanges, scanBundle } from "../../../scripts/release/scan-repo.mjs";

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (role: string) => `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ role, ref: "abcdefghijklmnopqrst", exp: 4102444800 })}.${"s".repeat(30)}`;
const join = (...parts: string[]) => parts.join("");

describe("literal NUL scan", () => {
  it("finds a NUL byte in a text file and ignores binary types and clean files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nul-scan-"));
    try {
      fs.writeFileSync(path.join(dir, "bad.ts"), Buffer.from([0x61, 0x00, 0x62]));
      fs.writeFileSync(path.join(dir, "good.ts"), "const a = '\\u0000';\n");
      fs.writeFileSync(path.join(dir, "image.png"), Buffer.from([0, 1, 2, 0]));
      expect(findNulFiles(dir, ["bad.ts", "good.ts", "image.png", "missing.ts"])).toEqual(["bad.ts"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("secret scan", () => {
  it("detects service-role JWTs, secret keys, private keys, tokens and passworded database URLs — and reports only where, never what", () => {
    const secretJwt = jwt(join("service", "_role"));
    const files = [
      { path: "a.ts", text: `const key = "${secretJwt}";\n` },
      { path: "b.ts", text: `const k = '${join("sb_", "secret_")}abcdefghijklmnop';\n` },
      { path: "c.ts", text: `${join("-----BEGIN ", "RSA PRIVATE KEY-----")}\n` },
      { path: "d.ts", text: `const t = '${join("gh", "p_")}${"a".repeat(36)}';\n` },
      { path: "e.ts", text: `const u = '${join("post", "gres://admin:")}hunter22@db.example.com/prod';\n` },
      { path: "f.ts", text: `${join("SUPABASE_SERVICE_", "ROLE_", "KEY")} = 'abcdefghijklmnopqrstuvwxyz012345'\n` },
      { path: "g.ts", text: `const a = '${join("AK", "IA")}ABCDEFGHIJKLMNOP';\n` },
    ];
    const found = findSecrets(files) as { path: string; line: number; kind: string }[];
    expect(found.map((f) => f.path).sort()).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"]);
    const output = JSON.stringify(found);
    for (const value of [secretJwt, "abcdefghijklmnop", "hunter22", "abcdefghijklmnopqrstuvwxyz012345", "ABCDEFGHIJKLMNOP"]) expect(output).not.toContain(value);
  });

  it("does not flag the public anon browser key, local database URLs, environment references or placeholders", () => {
    const files = [
      { path: "env.ts", text: `const anon = "${jwt("anon")}";\n` },
      { path: "db.ts", text: `const u = '${join("post", "gres://postgres:postgres")}@localhost:5432/db';\nconst v = '${join("post", "gres://u:p")}@127.0.0.1/x';\n` },
      { path: "ref.ts", text: "const k = process.env.STAGING_SUPABASE_URL;\n" },
    ];
    expect(findSecrets(files)).toEqual([]);
  });
});

describe("changed-path authorization", () => {
  it("accepts the authorised areas and rejects everything else", () => {
    const ok = ["src/lib/financialEvidence/x.ts", "src/components/financialStatements/y.tsx", "docs/release/z.md", "supabase/migrations/20260919110000_financial_statements_persistence.sql", "package.json"];
    expect(authorizeChangedPaths(ok)).toEqual([]);
    const bad = ["src/lib/tax/kinga.ts", "supabase/functions/kinga-tax-engine/index.ts", "supabase/migrations/20260101000000_historical.sql", "src/pages/Dashboard.tsx", "supabase/config.toml", "src/integrations/supabase/client.ts"];
    expect(authorizeChangedPaths([...ok, ...bad])).toEqual(bad);
  });

  it("allows exactly the two new migrations, so an edit to any historical migration is a violation", () => {
    expect(AUTHORIZED.exact.filter((f: string) => f.startsWith("supabase/migrations/"))).toEqual(["supabase/migrations/20260919100000_financial_statements_rollout_control.sql", "supabase/migrations/20260919110000_financial_statements_persistence.sql"]);
  });
});

describe("payment-surface non-regression", () => {
  it("flags executable payment files and ignores tests and documents", () => {
    expect(paymentSurfaceChanges(["src/lib/commercial/payments/flutterwave.ts", "supabase/functions/flutterwave-webhook/index.ts", "src/lib/commercial/payments/checkoutBridge.ts"]).length).toBe(3);
    expect(paymentSurfaceChanges(["src/lib/commercial/payments/__tests__/x.test.ts", "docs/payments.md", "src/lib/financialEvidence/x.ts"])).toEqual([]);
  });
});

describe("production-bundle scan", () => {
  it("flags the operator surface, harness, local-identity label, workbook reader and any stray production reference", () => {
    const ref = join("bvyivmmfjejb", "mqoydezk");
    expect(scanBundle([{ path: "dist/a.js", text: `const u="https://${ref}.supabase.co";` }])).toEqual([]);
    for (const token of ["service_role", "fs_set_company_rollout", "fs_commit_revision", "dev-harness", "LOCAL_SIMULATED_IDENTITY", "Internal preview", "fflate", "inspectWorkbook"]) {
      expect(scanBundle([{ path: "dist/x.js", text: `x("${token}")` }]).length, token).toBeGreaterThan(0);
    }
    expect(scanBundle([{ path: "dist/y.js", text: `log("${ref}")` }]).length).toBe(1);
  });
});
