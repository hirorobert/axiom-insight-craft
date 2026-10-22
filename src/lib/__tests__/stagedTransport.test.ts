/**
 * The staged release transport (scripts/release/stagedTransport.mjs): the six small submissions are deterministic renders
 * of committed bytes at the approved commit, equal to their REGISTERED forms; the staged artifacts are exactly the
 * approved wrappers / preflights / postconditions; and the migration-authority guard accepts the transport mirrors only
 * in a registered form. Real-PostgreSQL behaviour is proven by scripts/db-proof/stagedTransport.mjs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  APPROVED_COMMIT, BATCHES, BOOTSTRAP_PREDECESSOR, KINDS, REGISTERED_TRANSPORT_FORMS, TRANSPORT_DIR,
  checkTransportMirror, committedBytes, renderAll, renderApply, renderBootstrap, transportForms,
} from "../../../scripts/release/stagedTransport.mjs";
import { RELEASE_JOURNAL, SUBMISSION_FORMS } from "../../../scripts/ci/releaseJournal.mjs";
import { checkMigrationAuthority } from "../../../scripts/ci/assertMigrationAuthority.mjs";

const ROOT = path.resolve(__dirname, "../../..");
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

describe("staged release transport", () => {
  it("the approved commit is daa23e4 and the bootstrap follows hosted id 64", () => {
    expect(APPROVED_COMMIT).toBe("daa23e4113dc726fab867480dac6b0b6aba0bbfc");
    expect(BOOTSTRAP_PREDECESSOR).toEqual({ id: 64, hash: "8122917c23abca8726e7ee763796ffae568179233c9537b61a5aff35310f17bc" });
    expect(BATCHES.map((b) => b.batch)).toEqual(["fs-controls-r1", "fs-journey-r1", "fs-bounds-r1", "fs-capacity-r1", "fs-memo-r1"]);
  });

  for (const b of BATCHES) {
    it(`${b.batch}: every staged artifact is its committed bytes, unchanged in the working tree; the wrapper is the registered one`, () => {
      for (const k of KINDS) {
        const bytes = committedBytes(b[k].path);
        expect(bytes.length).toBe(b[k].bytes);
        expect(sha(bytes)).toBe(b[k].sha256);
        expect(fs.readFileSync(path.join(ROOT, b[k].path)).equals(bytes)).toBe(true);
      }
      expect(SUBMISSION_FORMS[b.source].wrapper).toEqual({ bytes: b.wrapper.bytes, sha256: b.wrapper.sha256 });
    });
  }

  it("every generated file is exactly its rendering", () => {
    for (const [rel, text] of Object.entries(renderAll())) expect(fs.readFileSync(path.join(ROOT, rel), "utf8"), rel).toBe(text);
    expect(fs.readdirSync(path.join(ROOT, TRANSPORT_DIR)).filter((f) => f.endsWith(".sql")).length).toBe(6);
  });

  it("the renders equal their registered forms, and each apply names its predecessor's registered hashes", () => {
    const forms = transportForms();
    for (const f of forms) {
      const r = REGISTERED_TRANSPORT_FORMS[f.name as keyof typeof REGISTERED_TRANSPORT_FORMS];
      expect([r.bytes, r.sha256, r.withFinalLf]).toEqual([f.bytes, ...f.hashes]);
      expect(f.text.endsWith("\n")).toBe(false);
    }
    expect(renderBootstrap()).toContain(`ARRAY['${BOOTSTRAP_PREDECESSOR.hash}']::text[]`);
    BATCHES.forEach((_, i) => {
      const prev = forms[i];
      expect(renderApply(i)).toContain(`ARRAY['${prev.hashes[0]}', '${prev.hashes[1]}']::text[]`);
    });
  });

  it("each apply is one DO statement: lock, predecessor, prior batch, literal identities, three EXECUTEs, consumption after them; no grant", () => {
    BATCHES.forEach((b, i) => {
      const t = renderApply(i);
      expect(t.match(/^DO \$/gm)).toHaveLength(1);
      expect(t.match(/\bEXECUTE v_(preflight|wrapper|postcondition);/g)).toEqual(["EXECUTE v_preflight;", "EXECUTE v_wrapper;", "EXECUTE v_postcondition;"]);
      expect(t.match(/\bEXECUTE\b/g)).toHaveLength(3);
      expect(t).not.toMatch(/\b(GRANT|REVOKE|DROP|TRUNCATE|DELETE|CREATE|ALTER)\b/);
      const order = ["pg_advisory_xact_lock", "TRANSPORT_WRONG_PREDECESSOR", "TRANSPORT_PRIOR_NOT_APPLIED", "FOR UPDATE", "TRANSPORT_ALREADY_APPLIED",
        "EXECUTE v_preflight", "EXECUTE v_wrapper", "EXECUTE v_postcondition", "TRANSPORT_SIGNOFF_BASELINE_CHANGED", "SET consumed_at", "'applied'"];
      const at = order.map((s) => t.indexOf(s));
      expect(at.every((x) => x >= 0)).toBe(true);
      expect([...at].sort((x, y) => x - y)).toEqual(at);
      for (const k of KINDS) expect(t).toContain(`= ${b[k].bytes}\n     AND encode(sha256(convert_to(s.body, 'UTF8')), 'hex') = '${b[k].sha256}'`);
      expect(t).toContain(i === 0 ? "c_prior       CONSTANT text   := NULL;" : `c_prior       CONSTANT text   := '${BATCHES[i - 1].batch}';`);
    });
  });

  it("the bootstrap revokes every client role, enables RLS and grants nothing", () => {
    const t = renderBootstrap();
    expect(t).not.toMatch(/\bGRANT\b/);
    expect(t.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(2);
    for (const s of ["REVOKE ALL ON SCHEMA cfoclose_release FROM PUBLIC", "ARRAY['anon', 'authenticated', 'service_role']", "TRANSPORT_STAGE_IMMUTABLE", "BEFORE TRUNCATE"]) expect(t).toContain(s);
    expect(t).not.toMatch(/SECURITY DEFINER/);
  });

  it("function revokes target only the three newly created helper signatures, never all schema functions", () => {
    const t = renderBootstrap();
    expect(t).not.toMatch(/\bON\s+ALL\s+FUNCTIONS\s+IN\s+SCHEMA\b/i);
    const targets = [...t.matchAll(/REVOKE EXECUTE ON FUNCTION ([\w.]+\([^)]*\)) FROM (PUBLIC|%I)/g)];
    const helpers = ["cfoclose_release.approved_artifact(text, text)", "cfoclose_release.staged_artifacts_guard()", "cfoclose_release.append_only_guard()"];
    expect(targets.map((m) => [m[1], m[2]])).toEqual([
      ...helpers.map((h) => [h, "PUBLIC"]), ...helpers.map((h) => [h, "%I"]),
    ]);
    expect(t.match(/\bREVOKE\b/g)).toHaveLength(10);
    for (const helper of helpers) expect(t).toContain(`CREATE FUNCTION ${helper.replace("(text, text)", "(p_batch text, p_kind text, OUT bytes integer, OUT sha256 text)")}`);
  });

  describe("migration authority with the six transport mirrors", () => {
    const added: string[] = [];
    const saved = new Map<string, unknown>();
    afterEach(() => {
      for (const t of added.splice(0)) delete (RELEASE_JOURNAL as Record<string, unknown>)[t];
      for (const [t, e] of saved) (RELEASE_JOURNAL as Record<string, unknown>)[t] = e;
      saved.clear();
    });

    function simulate(mutate?: (name: string, text: string) => string) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transport-authority-"));
      fs.mkdirSync(path.join(dir, "supabase"), { recursive: true });
      fs.symlinkSync(path.join(ROOT, "supabase/migrations"), path.join(dir, "supabase/migrations"));
      fs.cpSync(path.join(ROOT, "drizzle"), path.join(dir, "drizzle"), { recursive: true });
      const jf = path.join(dir, "drizzle/migrations/meta/_journal.json");
      const j = JSON.parse(fs.readFileSync(jf, "utf8"));
      // The real hosted transport entries (0064–0069) are removed from the copy, so the simulation re-applies them from the
      // rendered forms (and their mutations) at the same journal positions; the real registrations are restored afterwards.
      const names = transportForms().map((f) => f.name);
      j.entries = j.entries.filter((e: { tag: string }) => {
        if (!names.some((n) => e.tag.endsWith(`_${n}`))) return true;
        fs.rmSync(path.join(dir, "drizzle/migrations", `${e.tag}.sql`));
        const snap = path.join(dir, "drizzle/migrations/meta", `${e.tag.slice(0, 4)}_snapshot.json`);
        if (fs.existsSync(snap)) fs.rmSync(snap);
        if (!saved.has(e.tag)) saved.set(e.tag, (RELEASE_JOURNAL as Record<string, unknown>)[e.tag]);
        delete (RELEASE_JOURNAL as Record<string, unknown>)[e.tag];
        return false;
      });
      let when = j.entries.at(-1).when;
      transportForms().forEach((f, i) => {
        const idx = j.entries.length;
        const tag = `${String(idx).padStart(4, "0")}_${f.name}`;
        const text = mutate ? mutate(f.name, f.text) : f.text;
        fs.writeFileSync(path.join(dir, "drizzle/migrations", `${tag}.sql`), text);
        // drizzle-kit writes a snapshot per custom migration (schema unchanged): the previous one, as the migrator does.
        fs.copyFileSync(path.join(dir, "drizzle/migrations/meta", `${String(idx - 1).padStart(4, "0")}_snapshot.json`), path.join(dir, "drizzle/migrations/meta", `${String(idx).padStart(4, "0")}_snapshot.json`));
        j.entries.push({ idx, version: "7", when: (when += 1000), tag, breakpoints: true });
        (RELEASE_JOURNAL as Record<string, unknown>)[tag] = { kind: "staged_transport", sha256: sha(Buffer.from(f.text, "utf8")) };
        added.push(tag);
        void i;
      });
      fs.writeFileSync(jf, JSON.stringify(j, null, 2));
      try { return checkMigrationAuthority(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    it("accepts them exactly; the five sources are then mirrored, nothing pending", () => {
      const r = simulate();
      expect(r.errors).toEqual([]);
      for (const b of BATCHES) expect(r.mirrored.some((m: { source: string; how: string }) => m.source === b.source && m.how === "staged_transport")).toBe(true);
      for (const b of BATCHES) expect(r.pending).not.toContain(b.source);
    });

    it("refuses a mirror with one changed byte", () => {
      const r = simulate((name, text) => (name === "fs_bounds_r1_staged_apply" ? text.replace("apply fs-bounds-r1", "apply fs-bounds-r2") : text));
      expect(r.ok).toBe(false);
      expect(r.errors.join("\n")).toMatch(/fs_bounds_r1_staged_apply/);
    });

    it("checkTransportMirror accepts exactly the text or the text plus one LF", () => {
      const f = transportForms()[1];
      expect(checkTransportMirror(`0065_${f.name}`, f.text).problems).toEqual([]);
      expect(checkTransportMirror(`0065_${f.name}`, f.text + "\n").problems).toEqual([]);
      expect(checkTransportMirror(`0065_${f.name}`, f.text + "\n\n").problems.length).toBeGreaterThan(0);
      expect(checkTransportMirror("0065_unregistered", f.text).problems.length).toBeGreaterThan(0);
    });
  });
});
