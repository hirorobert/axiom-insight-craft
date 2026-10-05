/**
 * Hosted journal entry 0027 (applied by Lovable, hash 2776fc2b…, when 1791137643914) mirrors
 * supabase/migrations/20261003100000_account_review_digest_schema_qualification.sql. Classification saving failed in
 * production because resolve_account_review_batch runs with search_path = public, pg_catalog while pgcrypto lives in
 * schema "extensions". This pins that the fix changes exactly ONE thing: the one digest(...) call becomes
 * extensions.digest(...). Signature, return type, SECURITY DEFINER, search_path, every authorization check and the hashed
 * bytes are byte-identical to the previous live definition (20260925140000), and the file grants nothing.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const SOURCE = "supabase/migrations/20261003100000_account_review_digest_schema_qualification.sql";
const MIRROR = "drizzle/migrations/0027_account_review_digest_schema_qualification.sql";
const PREVIOUS = "supabase/migrations/20260925140000_workspace_capability_authorization.sql";

/** The full CREATE OR REPLACE FUNCTION public.resolve_account_review_batch(...) … $tag$ text in a file. */
function definition(text: string): string {
  const start = text.indexOf("CREATE OR REPLACE FUNCTION public.resolve_account_review_batch(");
  expect(start).toBeGreaterThanOrEqual(0);
  const tag = /\$\w*\$/.exec(text.slice(start))![0];
  const open = text.indexOf(tag, start);
  return text.slice(start, text.indexOf(tag, open + tag.length) + tag.length);
}

describe("hosted 0027: the account-review digest qualification", () => {
  it("the journal mirror is the source byte for byte, with the hash and timestamp of the hosted row", () => {
    const source = fs.readFileSync(path.join(ROOT, SOURCE));
    expect(fs.readFileSync(path.join(ROOT, MIRROR)).equals(source)).toBe(true);
    expect(crypto.createHash("sha256").update(source).digest("hex")).toBe("2776fc2b0e6e18005b0700b966c2d66ca1910429e03bb3554c3f47d4cbf459ff");
    const journal = JSON.parse(read("drizzle/migrations/meta/_journal.json")) as { entries: { idx: number; when: number; tag: string }[] };
    expect(journal.entries.find((e) => e.tag === "0027_account_review_digest_schema_qualification")).toMatchObject({ idx: 27, when: 1791137643914 });
  });

  it("re-creates the function identical to its previous definition except one call qualified as extensions.digest", () => {
    const fixed = definition(read(SOURCE));
    const previous = definition(read(PREVIOUS));
    expect(previous.match(/(?<![\w.])digest\(/g)).toHaveLength(1);
    expect(fixed.match(/(?<![\w.])digest\(/g)).toBeNull();
    expect(fixed.match(/extensions\.digest\(/g)).toHaveLength(1);
    expect(fixed).toBe(previous.replace(/(?<![\w.])digest\(/, "extensions.digest("));
    expect(fixed).toMatch(/SECURITY DEFINER\s+SET search_path TO 'public', 'pg_catalog'/);
  });

  it("the file contains that one function and nothing else: no grant, revoke, table, data or other function change", () => {
    const withoutComments = read(SOURCE).replace(/--[^\n]*/g, "");
    expect(withoutComments.replace(definition(read(SOURCE)), "").trim().replace(/;$/, "").trim()).toBe("");
  });
});
