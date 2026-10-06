/**
 * requestReprocess (S1, 20261006100000): the browser asks the server to start a new check and invokes processing with
 * the same operation id only when the server accepted or replayed it. Behaviour against real PostgreSQL is proven by
 * scripts/db-proof/mappingProcessingAuthority.mjs; this file pins the client contract and that no browser path writes
 * an upload's processing fields any more.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseMyWorkspaceCapabilities } from "@/lib/auth/workspaceCapabilities";
import { parseWorkspaceCommercialState } from "@/lib/commercial/paidActions";
import {
  mayRequestReprocess,
  mayInvokeProcessing,
  parseReprocessResponse,
  ReprocessRefusedError,
  reprocessRefusalMessage,
  requestReprocess,
  type ReprocessClient,
} from "./requestReprocess";

const ROOT = path.join(__dirname, "../../../");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

function fakeClient(answer: unknown, opts: { storedHash?: string | null; rpcError?: { message: string } | null; invokeError?: unknown } = {}) {
  const calls: { kind: string; args: unknown }[] = [];
  const client: ReprocessClient = {
    from: () => ({
      select: () => ({
        eq: (_c, id) => ({
          maybeSingle: async () => {
            calls.push({ kind: "read", args: id });
            return { data: { source_file_hash: opts.storedHash ?? null }, error: null };
          },
        }),
      }),
    }),
    rpc: async (name, args) => {
      calls.push({ kind: "rpc", args: { name, ...args } });
      return { data: answer, error: opts.rpcError ?? null };
    },
    functions: {
      invoke: async (name, options) => {
        calls.push({ kind: "invoke", args: { name, ...options.body } });
        return { error: opts.invokeError ?? null };
      },
    },
  };
  return { client, calls };
}
const deps = { ensureFreshSession: async () => undefined, newOperationId: () => "op-1" };
const answer = (outcome: string, code = outcome === "accepted" ? "ACCEPTED" : "IN_PROGRESS") =>
  ({ outcome, code, upload_id: "u-1", operation_id: "op-1", invalidated_certification_id: null });

describe("requestReprocess — the server decides before processing is invoked", () => {
  it("accepted → invokes process-trial-balance with the SAME operation id as clientRequestId, naming the stored source hash", async () => {
    const { client, calls } = fakeClient(answer("accepted"), { storedHash: "abc" });
    const r = await requestReprocess(client, "u-1", deps);
    expect(r.outcome).toBe("accepted");
    expect(calls.map((c) => c.kind)).toEqual(["read", "rpc", "invoke"]);
    expect(calls[1].args).toEqual({ name: "tbu_request_reprocess", p_upload_id: "u-1", p_operation_id: "op-1", p_expected_source_hash: "abc" });
    expect(calls[2].args).toEqual({ name: "process-trial-balance", uploadId: "u-1", clientRequestId: "op-1" });
  });

  it("replayed → invokes processing (a retry of an accepted request)", async () => {
    const { client, calls } = fakeClient(answer("replayed", "ACCEPTED"));
    await requestReprocess(client, "u-1", deps);
    expect(calls.at(-1)?.kind).toBe("invoke");
  });

  for (const [outcome, code] of [["refused", "CAPABILITY_REQUIRED"], ["refused", "IN_PROGRESS"], ["refused", "SOURCE_CHANGED"], ["conflict", "IDEMPOTENCY_KEY_REUSED"]] as const) {
    it(`${outcome} ${code} → throws a named refusal and NEVER invokes processing`, async () => {
      const { client, calls } = fakeClient(answer(outcome, code));
      const err = await requestReprocess(client, "u-1", deps).catch((e) => e);
      expect(err).toBeInstanceOf(ReprocessRefusedError);
      expect(err.code).toBe(code);
      expect(err.message).toBe(reprocessRefusalMessage(code));
      expect(calls.some((c) => c.kind === "invoke")).toBe(false);
    });
  }

  it("a transport error from the request is thrown and processing is not invoked", async () => {
    const { client, calls } = fakeClient(null, { rpcError: { message: "function does not exist" } });
    await expect(requestReprocess(client, "u-1", deps)).rejects.toEqual({ message: "function does not exist" });
    expect(calls.some((c) => c.kind === "invoke")).toBe(false);
  });

  it("an unrecognised answer is read as a refusal (fail closed)", () => {
    for (const data of [null, undefined, "accepted", [], [{ outcome: "accepted" }], { outcome: "ok" }, { code: "ACCEPTED" }]) {
      const r = parseReprocessResponse(data);
      expect(r.outcome).toBe("refused");
      expect(mayInvokeProcessing(r)).toBe(false);
    }
    expect(reprocessRefusalMessage("SOMETHING_NEW")).toBe("A new check could not be started.");
  });
});

describe("no browser path writes an upload's processing fields (S1)", () => {
  const CALL_SITES = ["src/components/AccountReviewPanel.tsx", "src/components/UploadsStatusPanel.tsx", "src/pages/workspace/WorkspaceOverview.tsx"];

  it("the three former writers request a new check through requestReprocess", () => {
    for (const f of CALL_SITES) {
      const src = read(f);
      expect(src, f).toMatch(/requestReprocess\(supabase as unknown as ReprocessClient, /);
      expect(src, f).not.toMatch(/functions\.invoke\(\s*"process-trial-balance"/);
    }
  });

  it("no source file under src/ updates or inserts trial_balance_uploads directly", () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
      }
      return out;
    };
    const offenders = walk(path.join(ROOT, "src")).filter((p) =>
      /from\(\s*["']trial_balance_uploads["']\s*\)\s*\.(update|insert|upsert|delete)\(/.test(fs.readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  }, 60_000); // a full walk of src/ (no file is skipped)

  it("processing is invoked from the browser only after the server accepted the request", () => {
    const src = read("src/lib/workspace/requestReprocess.ts");
    const gate = src.indexOf("if (!mayInvokeProcessing(response)) throw");
    const invoke = src.indexOf('client.functions.invoke("process-trial-balance"');
    expect(gate).toBeGreaterThan(0);
    expect(invoke).toBeGreaterThan(gate);
    expect(src).toContain("clientRequestId: operationId");
  });
});

describe("Retry availability matches tbu_request_reprocess's authority (S1)", () => {
  const caps = (capabilities: string[], allowed: string[], plan = true) =>
    parseMyWorkspaceCapabilities({ access: true, capabilities, allowed, has_current_plan: plan });
  const PREPARE = caps(["prepare_close"], ["prepare_close"]);
  const commercial = (allowed: boolean, code = allowed ? "ALLOWED" : "ENTITLEMENT_REQUIRED") =>
    parseWorkspaceCommercialState({ access: true, plan_code: "SOLO", capabilities: { CLOSE_ASSURANCE: { allowed, code } } });
  const ENTITLED = commercial(true);
  const active = { lifecycle_state: "active_processed" };

  it("offered only for an active upload AND prepare_close AND the CLOSE_ASSURANCE entitlement", () => {
    expect(mayRequestReprocess(active, PREPARE, ENTITLED)).toBe(true);
    expect(mayRequestReprocess({ lifecycle_state: "retired" }, PREPARE, ENTITLED)).toBe(false);
  });

  it("not offered without prepare_close: other capabilities, held-but-not-allowed (no plan), no access, unknown", () => {
    expect(mayRequestReprocess(active, caps(["review_close", "issue_reporting_pack"], ["review_close", "issue_reporting_pack"]), ENTITLED)).toBe(false);
    expect(mayRequestReprocess(active, caps(["prepare_close"], [], false), ENTITLED)).toBe(false);
    expect(mayRequestReprocess(active, parseMyWorkspaceCapabilities({ access: false, capabilities: [], allowed: [] }), ENTITLED)).toBe(false);
    expect(mayRequestReprocess(active, null, ENTITLED)).toBe(false);
  });

  it("not offered without the processing entitlement: refused, missing, malformed, no access, or unknown commercial state", () => {
    expect(mayRequestReprocess(active, PREPARE, commercial(false))).toBe(false);
    expect(mayRequestReprocess(active, PREPARE, commercial(true, "SOMETHING_ELSE"))).toBe(false);
    expect(mayRequestReprocess(active, PREPARE, parseWorkspaceCommercialState({ access: true, capabilities: {} }))).toBe(false);
    expect(mayRequestReprocess(active, PREPARE, parseWorkspaceCommercialState({ access: false }))).toBe(false);
    expect(mayRequestReprocess(active, PREPARE, null)).toBe(false);
  });

  it("an engagement service grant is not a workspace capability: a service name never makes Retry available", () => {
    expect(mayRequestReprocess(active, caps(["TRIAL_BALANCE_REVIEW", "FINANCIAL_STATEMENTS"], ["TRIAL_BALANCE_REVIEW", "FINANCIAL_STATEMENTS"]), ENTITLED)).toBe(false);
  });

  it("every Retry surface uses the predicate with both inputs (no lifecycle-only Retry remains)", () => {
    const ov = read("src/pages/workspace/WorkspaceOverview.tsx");
    expect(ov).toContain("useWorkspaceCapabilities(companyId)");
    expect(ov).toContain("useWorkspaceCommercialState(companyId)");
    expect(ov).toMatch(/onRetry: mayRequestReprocess\(upload, myCapabilities, commercial\)/);
    const panel = read("src/components/UploadsStatusPanel.tsx");
    expect(panel).toContain("mayRetry={mayRequestReprocess(u, capabilities, commercial)}");
    expect(panel).toContain("!mayRequestReprocess(u, capabilities, commercial)) return;");
    expect(panel).not.toContain("canReprocessUpload(");
  });
});
