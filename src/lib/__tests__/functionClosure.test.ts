import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM release tool without type declarations
import { closureOf, functionManifest, migrationManifest } from "../../../scripts/release/functionClosure.mjs";

const ROOT = path.resolve(__dirname, "../../..");
type Manifest = { function: string; files: { path: string; size: number; sha256: string }[]; remote: string[]; closureSha256: string };

describe("deployment manifests cover the whole function closure", () => {
  it("trial-balance-layout ships its entry point, the shared authentication modules and every layout/ingestion module", () => {
    const m = functionManifest("trial-balance-layout") as Manifest;
    expect(m.files.map((f) => f.path.replace("supabase/functions/", ""))).toEqual([
      "_shared/auth.ts", "_shared/currencyRegistry.ts", "_shared/hash.ts", "_shared/layoutConfirmationRead.ts", "_shared/layoutProfile.ts",
      "_shared/namedUserAccess.ts", "_shared/paidAction.ts", "_shared/processingActor.ts", "_shared/tbIngestion.ts", "_shared/tbSource.ts",
      "_shared/trialBalanceLayout.ts", "_shared/uploadLifecycle.ts", "trial-balance-layout/index.ts",
    ]);
    expect(m.remote).toEqual(["https://deno.land/std@0.168.0/http/server.ts", "https://esm.sh/@supabase/supabase-js@2", "https://esm.sh/xlsx@0.18.5"]);
  });
  it("process-trial-balance's closure includes the layout modules it now reads", () => {
    const paths = (functionManifest("process-trial-balance") as Manifest).files.map((f) => f.path);
    for (const p of ["supabase/functions/_shared/layoutConfirmationRead.ts", "supabase/functions/_shared/layoutProfile.ts", "supabase/functions/_shared/tbIngestion.ts", "supabase/functions/process-trial-balance/index.ts"]) expect(paths).toContain(p);
  });
  it("every hash is the file's real SHA-256; the closure digest is deterministic and changes with any file", () => {
    const m = functionManifest("trial-balance-layout") as Manifest;
    for (const f of m.files) expect(f.sha256).toBe(createHash("sha256").update(fs.readFileSync(path.join(ROOT, f.path))).digest("hex"));
    expect((functionManifest("trial-balance-layout") as Manifest).closureSha256).toBe(m.closureSha256);
    const expected = createHash("sha256").update(m.files.map((f) => `${f.sha256}  ${f.path}`).join("\n") + "\n").digest("hex");
    expect(m.closureSha256).toBe(expected);
  });
  it("an unresolvable relative import fails loudly (never a partial manifest)", () => {
    const dir = fs.mkdtempSync(path.join(ROOT, "node_modules", ".closure-test-"));
    try {
      fs.writeFileSync(path.join(dir, "index.ts"), 'import { x } from "./missing.ts";\n');
      expect(() => closureOf(path.join(dir, "index.ts"))).toThrow(/unresolved import/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("migration manifests carry the full SHA-256", () => {
    const m = migrationManifest("20261010100000_layout_templates_and_confirmations.sql") as { sha256: string; size: number };
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.size).toBe(fs.statSync(path.join(ROOT, "supabase/migrations/20261010100000_layout_templates_and_confirmations.sql")).size);
  });
});
