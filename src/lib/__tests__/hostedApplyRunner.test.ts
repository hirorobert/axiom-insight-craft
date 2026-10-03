/**
 * The controlled hosted-apply runner for 20261002100000 (scripts/release/hosted-apply/applyCandidate.mjs): its pinned
 * manifest agrees with the repository, its target checks fail closed, and its classifier never guesses. Behaviour on a
 * real database (apply, repeat, induced failures, concurrency, conflicts) is proven by scripts/db-proof/hostedApply.mjs.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkTargetUrl, classify, isCleanPreState, loadCandidate, postconditionFailures } from "../../../scripts/release/hosted-apply/applyCandidate.mjs";

const ROOT = path.resolve(__dirname, "../../..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/release/hosted-apply/candidate-20261002100000.json"), "utf8"));
const REF = manifest.productionRef as string;

describe("the manifest is pinned to the repository", () => {
  it("the candidate file is exactly the approved bytes and SHA-256", () => {
    const c = loadCandidate(manifest, ROOT);
    expect(c).toMatchObject({ bytes: 10824, sha: "704beb2d1c2cc3a1276633055cbf3fc049d26049db4ce60565130a4d550cf0f8" });
  });

  it("the expected journal lineage is the repository journal's last entry, hashed exactly as drizzle-orm hashes it", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(ROOT, "drizzle/migrations/meta/_journal.json"), "utf8"));
    const last = journal.entries.at(-1);
    const text = fs.readFileSync(path.join(ROOT, "drizzle/migrations", `${last.tag}.sql`)).toString();
    expect(manifest.journal.expectedLastBeforeApply).toEqual({ tag: last.tag, hash: crypto.createHash("sha256").update(text).digest("hex"), createdAt: last.when });
    expect(manifest.journalTag).toBe(`${String(journal.entries.length).padStart(4, "0")}_apply_20261002100000_refuse_withheld_service_grants`);
  });

  it("the expected RPC lines and the withheld list are the ones in the approved SQL", () => {
    const sql = fs.readFileSync(path.join(ROOT, manifest.source), "utf8");
    for (const line of Object.values(manifest.postconditions.rpcLines) as string[]) expect(sql.split(line).length - 1).toBe(1);
    expect(sql).toContain(`ARRAY[${manifest.postconditions.withheld.map((c: string) => `'${c}'`).join(", ")}]`);
    expect(sql).toMatch(/AFTER INSERT ON public\.engagement_mandate_events/);
  });
});

describe("target identity fails closed", () => {
  it("accepts the project's direct host or pooler user, nothing else", () => {
    expect(checkTargetUrl(`postgresql://postgres:x@db.${REF}.supabase.co:5432/postgres`, REF)).toBeNull();
    expect(checkTargetUrl(`postgresql://postgres.${REF}:x@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`, REF)).toBeNull();
    expect(checkTargetUrl("postgresql://postgres:x@db.aaaaaaaaaaaaaaaaaaaa.supabase.co:5432/postgres", REF)).toMatch(/does not name project/);
    expect(checkTargetUrl(`postgresql://postgres:x@db.${REF}.evil.example/postgres`, REF)).toMatch(/does not name project/);
    expect(checkTargetUrl(`postgresql://postgres.${REF}:x@pooler.evil.example:5432/postgres`, REF)).toMatch(/does not name project/);
    expect(checkTargetUrl(`postgresql://postgres.${REF}x:x@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`, REF)).toMatch(/does not name project/);
    expect(checkTargetUrl("postgresql://postgres:x@localhost/postgres", REF)).toMatch(/does not name project/);
    expect(checkTargetUrl("not a url", REF)).toMatch(/not a valid URL/);
    expect(checkTargetUrl(`postgresql://postgres:x@db.${REF}.supabase.co/postgres`, "short")).toMatch(/20-character/);
  });

  it("disposable mode is loopback-only and refuses a URL naming the production project", () => {
    expect(checkTargetUrl("postgres://postgres:x@localhost:5432/db", "", { disposable: true, productionRef: REF })).toBeNull();
    expect(checkTargetUrl("postgres://postgres:x@10.0.0.5:5432/db", "", { disposable: true, productionRef: REF })).toMatch(/loopback/);
    expect(checkTargetUrl(`postgres://postgres.${REF}:x@localhost:5432/db`, "", { disposable: true, productionRef: REF })).toMatch(/production project/);
  });
});

describe("the classifier never guesses", () => {
  const L = manifest.journal.expectedLastBeforeApply;
  const clean = {
    journalExists: true,
    rows: [{ hash: L.hash, created_at: String(L.createdAt) }],
    fns: [] as unknown[], trig: [] as unknown[],
    lines: { grant_engagement_capability: 0, open_engagement_with_scope: 0 },
    rpcPrivileges: { grant_auth: true, grant_anon: false, open_auth: true, open_anon: false },
    behaviour: null,
  };
  const applied = {
    ...clean,
    rows: [{ hash: manifest.sha256, created_at: "1790999999999" }, ...clean.rows],
    fns: [
      { proname: "capability_customer_available", args: "p_capability text", volatility: "i", secdef: false, config: ["search_path=pg_catalog, public"], acl: "{postgres=X/postgres}", owner: "postgres" },
      { proname: "assert_capability_available", args: "p_capability text", volatility: "s", secdef: false, config: ["search_path=pg_catalog, public"], acl: "{postgres=X/postgres}", owner: "postgres" },
      { proname: "refuse_withheld_service_grant", args: "", volatility: "v", secdef: true, config: ["search_path=pg_catalog, public"], acl: "{postgres=X/postgres}", owner: "postgres" },
    ],
    trig: [{ tgname: "trg_refuse_withheld_service_grant", tgtype: 5, tgenabled: "O", fn: "refuse_withheld_service_grant" }],
    lines: { grant_engagement_capability: 1, open_engagement_with_scope: 1 },
    behaviour: { TAX_COMPUTATION: false, COMPLIANCE_REVIEW: false, FILING_PREPARATION: false, MONITORING: false, FINANCIAL_STATEMENTS: true },
  };

  it("clean pre-state on the expected lineage → UNAPPLIED; applied with postconditions → ALREADY_APPLIED", () => {
    expect(isCleanPreState(clean)).toBe(true);
    expect(classify(clean, manifest)).toEqual({ outcome: "UNAPPLIED" });
    expect(postconditionFailures(applied, manifest)).toEqual([]);
    expect(classify(applied, manifest)).toEqual({ outcome: "ALREADY_APPLIED", recordedAt: "1790999999999" });
  });

  it("every deviation is a CONFLICT", () => {
    const conflict = (f: object, opts = {}) => classify(f, manifest, opts).outcome;
    expect(conflict({ ...clean, journalExists: false })).toBe("CONFLICT");
    expect(conflict({ ...clean, rows: [] })).toBe("CONFLICT");                                               // lineage
    expect(conflict({ ...clean, rows: [{ hash: "x".repeat(64), created_at: "9" }, ...clean.rows] })).toBe("CONFLICT");
    expect(conflict({ ...clean, rows: applied.rows })).toBe("CONFLICT");                                      // recorded, not applied
    expect(conflict({ ...applied, rows: clean.rows })).toBe("CONFLICT");                                      // applied, not recorded
    expect(conflict({ ...clean, fns: [applied.fns[0]] })).toBe("CONFLICT");                                   // partial
    expect(conflict({ ...applied, rows: [applied.rows[0], ...applied.rows] })).toBe("CONFLICT");              // recorded twice
    expect(conflict(applied, { when: "1790999999998" })).toBe("CONFLICT");                                    // different when
    expect(conflict(clean, { when: String(L.createdAt) })).toBe("CONFLICT");                                  // when not after last
    expect(conflict({ ...applied, fns: applied.fns.map((f) => (f.proname === "assert_capability_available" ? { ...f, volatility: "v" } : f)) })).toBe("CONFLICT");
    expect(conflict({ ...applied, trig: [{ ...applied.trig[0], tgtype: 7 }] })).toBe("CONFLICT");             // BEFORE INSERT
    expect(conflict({ ...applied, fns: applied.fns.map((f) => ({ ...f, acl: "{postgres=X/postgres,=X/postgres}" })) })).toBe("CONFLICT"); // PUBLIC EXECUTE
  });
});
