import { assertEquals, assert } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { handleIntake, type IntakeDeps, type IntakeRequest, type AdminClientLike } from "./handleIntake.ts";
import type { FirmMemberActor } from "../_shared/actor.ts";
import { corsHeaders } from "../_shared/auth.ts";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nsome content");

function baseRequest(overrides: Partial<IntakeRequest> = {}): IntakeRequest {
  return {
    userId: "user-1",
    companyId: "company-1",
    periodYear: 2025,
    file: { name: "statements.pdf", type: "application/pdf", size: PDF_BYTES.length, bytes: PDF_BYTES },
    artifactClassHint: undefined,
    ...overrides,
  };
}

const CLEAN_SCAN = () => Promise.resolve({ outcome: "clean" as const });
const ALWAYS_HASH = () => Promise.resolve("a".repeat(64));

function actorFor(companyId: string): FirmMemberActor {
  return { firmMemberId: "fm-1", userId: "user-1", companyId, role: "preparer" };
}

/** A fake AdminClientLike that records every call, for assertion. */
function fakeAdmin(opts: {
  uploadResult?: { error: { message?: string; statusCode?: string } | null };
  rpcResult?: { data: unknown; error: { message?: string } | null };
} = {}) {
  const calls = { uploads: [] as string[], removes: [] as string[][], rpcs: [] as unknown[] };
  const admin: AdminClientLike = {
    storage: {
      from: (_bucket: string) => ({
        upload: (path: string) => {
          calls.uploads.push(path);
          return Promise.resolve(opts.uploadResult ?? { error: null });
        },
        remove: (paths: string[]) => {
          calls.removes.push(paths);
          return Promise.resolve({ error: null });
        },
      }),
    },
    rpc: (_fn: string, args: Record<string, unknown>) => {
      calls.rpcs.push(args);
      return Promise.resolve(
        opts.rpcResult ?? { data: { id: "doc-1", status: "STORED" }, error: null },
      );
    },
  };
  return { admin, calls };
}

// ── cross-company access ────────────────────────────────────────────────

Deno.test("handleIntake: cross-company access is denied before any storage/DB call — resolveFirmMemberActor's 403 short-circuits everything", async () => {
  const { admin, calls } = fakeAdmin();
  const deps: IntakeDeps = {
    resolveFirmMemberActor: () =>
      Promise.resolve(new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: corsHeaders })),
    scanForMalware: CLEAN_SCAN,
    sha256HexBytes: ALWAYS_HASH,
    admin,
    malwareScanWebhookUrl: "https://scanner.example/scan",
  };
  const res = await handleIntake(deps, baseRequest());
  assertEquals(res.status, 403);
  assertEquals(calls.uploads.length, 0);
  assertEquals(calls.rpcs.length, 0);
});

// ── fail-closed malware control reaches storage never ────────────────────

Deno.test("handleIntake: malware scan unavailable returns 503 and uploads nothing", async () => {
  const { admin, calls } = fakeAdmin();
  const deps: IntakeDeps = {
    resolveFirmMemberActor: (_a, _u, companyId) => Promise.resolve(actorFor(companyId)),
    scanForMalware: () => Promise.resolve({ outcome: "unavailable", reason: "not_configured" }),
    sha256HexBytes: ALWAYS_HASH,
    admin,
    malwareScanWebhookUrl: undefined,
  };
  const res = await handleIntake(deps, baseRequest());
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.error, "IntakeUnavailable");
  assertEquals(calls.uploads.length, 0);
  assertEquals(calls.rpcs.length, 0);
});

Deno.test("handleIntake: malware scan dirty rejects and uploads nothing", async () => {
  const { admin, calls } = fakeAdmin();
  const deps: IntakeDeps = {
    resolveFirmMemberActor: (_a, _u, companyId) => Promise.resolve(actorFor(companyId)),
    scanForMalware: () => Promise.resolve({ outcome: "dirty" }),
    sha256HexBytes: ALWAYS_HASH,
    admin,
    malwareScanWebhookUrl: "https://scanner.example/scan",
  };
  const res = await handleIntake(deps, baseRequest());
  assertEquals(res.status, 422);
  assertEquals(calls.uploads.length, 0);
  assertEquals(calls.rpcs.length, 0);
});

// ── deterministic path — identity depends ONLY on company/period/hash ───

Deno.test("handleIntake: the storage path used is content-addressed — company/period/hash only, never a filename/extension or a random id", async () => {
  const { admin, calls } = fakeAdmin();
  const deps: IntakeDeps = {
    resolveFirmMemberActor: (_a, _u, companyId) => Promise.resolve(actorFor(companyId)),
    scanForMalware: CLEAN_SCAN,
    sha256HexBytes: () => Promise.resolve("f".repeat(64)),
    admin,
    malwareScanWebhookUrl: "https://scanner.example/scan",
  };
  await handleIntake(deps, baseRequest({ companyId: "company-9", periodYear: 2027 }));
  assertEquals(calls.uploads, [`company-9/2027/${"f".repeat(64)}`]);
});

Deno.test("handleIntake: identical OOXML bytes submitted under .docx and .xlsx resolve to the exact same storage path", async () => {
  const OOXML_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]); // shared ZIP/OOXML magic + body
  const { admin, calls } = fakeAdmin();
  const deps: IntakeDeps = {
    resolveFirmMemberActor: (_a, _u, companyId) => Promise.resolve(actorFor(companyId)),
    scanForMalware: CLEAN_SCAN,
    sha256HexBytes: () => Promise.resolve("d".repeat(64)), // identical bytes -> identical hash, by construction
    admin,
    malwareScanWebhookUrl: "https://scanner.example/scan",
  };
  await handleIntake(deps, baseRequest({
    companyId: "company-7", periodYear: 2025,
    file: { name: "report.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: OOXML_BYTES.length, bytes: OOXML_BYTES },
  }));
  await handleIntake(deps, baseRequest({
    companyId: "company-7", periodYear: 2025,
    file: { name: "report.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: OOXML_BYTES.length, bytes: OOXML_BYTES },
  }));
  assertEquals(calls.uploads.length, 2);
  assertEquals(calls.uploads[0], calls.uploads[1]); // same path regardless of extension
  assertEquals(calls.uploads[0], `company-7/2025/${"d".repeat(64)}`);
});

// ── exact replay ────────────────────────────────────────────────────────

Deno.test("handleIntake: exact replay (storage reports 'already exists') returns the existing document and never removes the pre-existing object on a later unrelated DB error", async () => {
  const { admin, calls } = fakeAdmin({
    uploadResult: { error: { message: "The resource already exists", statusCode: "409" } },
    rpcResult: { data: { id: "doc-existing", status: "STORED" }, error: null },
  });
  const deps: IntakeDeps = {
    resolveFirmMemberActor: (_a, _u, companyId) => Promise.resolve(actorFor(companyId)),
    scanForMalware: CLEAN_SCAN,
    sha256HexBytes: ALWAYS_HASH,
    admin,
    malwareScanWebhookUrl: "https://scanner.example/scan",
  };
  const res = await handleIntake(deps, baseRequest());
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.documentId, "doc-existing");
  assertEquals(calls.removes.length, 0); // never removed — this request did not create the object
});

// ── storage success + database failure: NEVER delete (recoverable orphan) ─
//
// Corrected by the final surgical repair: deleting an object this request
// itself created is no longer safe to do on a DB failure, because under
// concurrency this request cannot prove a sibling request isn't relying on
// the same (content-addressed) path. The object is left in place; a retry
// reuses it.

Deno.test("handleIntake: a fresh upload followed by an unrelated DB failure does NOT remove the object — recoverable orphan, not cleanup", async () => {
  const { admin, calls } = fakeAdmin({
    uploadResult: { error: null }, // this request created the object
    rpcResult: { data: null, error: { message: "connection reset" } },
  });
  const deps: IntakeDeps = {
    resolveFirmMemberActor: (_a, _u, companyId) => Promise.resolve(actorFor(companyId)),
    scanForMalware: CLEAN_SCAN,
    sha256HexBytes: () => Promise.resolve("c".repeat(64)),
    admin,
    malwareScanWebhookUrl: "https://scanner.example/scan",
  };
  const res = await handleIntake(deps, baseRequest({ companyId: "company-5", periodYear: 2025 }));
  assertEquals(res.status, 502);
  assertEquals(calls.removes.length, 0); // never removed, regardless of who created the object
});

Deno.test("handleIntake: exact replay (object pre-existing) followed by an unrelated DB failure also does NOT remove the object", async () => {
  const { admin, calls } = fakeAdmin({
    uploadResult: { error: { message: "The resource already exists", statusCode: "409" } },
    rpcResult: { data: null, error: { message: "connection reset" } },
  });
  const deps: IntakeDeps = {
    resolveFirmMemberActor: (_a, _u, companyId) => Promise.resolve(actorFor(companyId)),
    scanForMalware: CLEAN_SCAN,
    sha256HexBytes: ALWAYS_HASH,
    admin,
    malwareScanWebhookUrl: "https://scanner.example/scan",
  };
  const res = await handleIntake(deps, baseRequest());
  assertEquals(res.status, 502);
  assertEquals(calls.removes.length, 0);
});

// ── adversarial concurrent-failure interleaving (Phase 4 of the final
// surgical repair) ────────────────────────────────────────────────────────
//
// Exact required interleaving:
//   A uploads object successfully.
//   B receives object-already-exists.
//   A's database RPC fails.
//   B's database RPC succeeds.
// Required: the object is not removed; B returns success; B's row
// references the existing object; only one storage path exists overall.

Deno.test("adversarial interleaving: A uploads + A's RPC fails, B replays + B's RPC succeeds — object survives, B succeeds, exactly one object", async () => {
  const stored = new Set<string>();
  const calls = { uploads: [] as string[], removes: [] as string[][], rpcs: [] as { label: string }[] };

  // Two independent admin fakes (A and B are different requests, possibly
  // different server instances) sharing the SAME underlying storage state
  // (`stored`) — exactly what a real shared bucket provides — but each
  // with ITS OWN scripted RPC outcome, to reproduce the exact interleaving
  // named by the directive regardless of call order or timing.
  function adminFor(label: "A" | "B", rpcOutcome: { data: unknown; error: { message?: string } | null }): AdminClientLike {
    return {
      storage: {
        from: () => ({
          upload: (path: string) => {
            calls.uploads.push(path);
            if (stored.has(path)) {
              return Promise.resolve({ error: { message: "The resource already exists", statusCode: "409" } });
            }
            stored.add(path);
            return Promise.resolve({ error: null });
          },
          remove: (paths: string[]) => {
            calls.removes.push(paths);
            stored.delete(paths[0]);
            return Promise.resolve({ error: null });
          },
        }),
      },
      rpc: (_fn: string, args: Record<string, unknown>) => {
        calls.rpcs.push({ label });
        return Promise.resolve(rpcOutcome);
      },
    };
  }

  const HASH = "b".repeat(64);
  const depsFor = (admin: AdminClientLike): IntakeDeps => ({
    resolveFirmMemberActor: (_a, _u, companyId) => Promise.resolve(actorFor(companyId)),
    scanForMalware: CLEAN_SCAN,
    sha256HexBytes: () => Promise.resolve(HASH),
    admin,
    malwareScanWebhookUrl: "https://scanner.example/scan",
  });
  const req = baseRequest({ companyId: "company-4", periodYear: 2025 });

  // A: uploads successfully (first to the path), then its own RPC fails.
  const resA = await handleIntake(
    depsFor(adminFor("A", { data: null, error: { message: "connection reset" } })),
    req,
  );
  // B: replays after A's upload already exists, then B's own RPC succeeds.
  const resB = await handleIntake(
    depsFor(adminFor("B", { data: { id: "doc-b-wins", status: "STORED" }, error: null })),
    req,
  );

  assertEquals(resA.status, 502); // A's DB failure is reported honestly
  assertEquals(resB.status, 200); // B succeeds
  const bodyB = await resB.json();
  assertEquals(bodyB.documentId, "doc-b-wins"); // B's row references the (existing) object

  assertEquals(calls.removes.length, 0); // the object is never removed, including after A's failure
  assertEquals(stored.size, 1); // only one storage path/object exists for this hash, ever
  assertEquals([...stored][0], `company-4/2025/${HASH}`);
});

Deno.test("handleIntake: a genuine storage upload error (not 'already exists') fails closed with 502 and never calls the RPC", async () => {
  const { admin, calls } = fakeAdmin({ uploadResult: { error: { message: "disk full" } } });
  const deps: IntakeDeps = {
    resolveFirmMemberActor: (_a, _u, companyId) => Promise.resolve(actorFor(companyId)),
    scanForMalware: CLEAN_SCAN,
    sha256HexBytes: ALWAYS_HASH,
    admin,
    malwareScanWebhookUrl: "https://scanner.example/scan",
  };
  const res = await handleIntake(deps, baseRequest());
  assertEquals(res.status, 502);
  assertEquals(calls.rpcs.length, 0);
});

// ── concurrent replay ────────────────────────────────────────────────────

Deno.test("handleIntake: concurrent replay — two requests for identical content both resolve to the same document, with only one real cleanup-eligible upload", async () => {
  // Shared fake storage state across both concurrent calls, simulating a
  // single underlying bucket: the first upload() to a given path succeeds,
  // every subsequent one to the SAME path reports 'already exists' —
  // exactly what real content-addressed object storage guarantees.
  const stored = new Set<string>();
  const calls = { uploads: [] as string[], removes: [] as string[][] };
  const admin: AdminClientLike = {
    storage: {
      from: () => ({
        upload: (path: string) => {
          calls.uploads.push(path);
          if (stored.has(path)) {
            return Promise.resolve({ error: { message: "The resource already exists", statusCode: "409" } });
          }
          stored.add(path);
          return Promise.resolve({ error: null });
        },
        remove: (paths: string[]) => {
          calls.removes.push(paths);
          return Promise.resolve({ error: null });
        },
      }),
    },
    // The DB's own unique_violation handling (see the migration's exception
    // block) means both concurrent RPC calls succeed and return the SAME row.
    rpc: () => Promise.resolve({ data: { id: "doc-concurrent", status: "STORED" }, error: null }),
  };
  const deps: IntakeDeps = {
    resolveFirmMemberActor: (_a, _u, companyId) => Promise.resolve(actorFor(companyId)),
    scanForMalware: CLEAN_SCAN,
    sha256HexBytes: () => Promise.resolve("e".repeat(64)),
    admin,
    malwareScanWebhookUrl: "https://scanner.example/scan",
  };
  const req = baseRequest({ companyId: "company-3", periodYear: 2025 });
  const [resA, resB] = await Promise.all([handleIntake(deps, req), handleIntake(deps, req)]);
  assertEquals(resA.status, 200);
  assertEquals(resB.status, 200);
  const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);
  assertEquals(bodyA.documentId, "doc-concurrent");
  assertEquals(bodyB.documentId, "doc-concurrent");
  assertEquals(calls.uploads.length, 2); // both attempted
  assertEquals(calls.removes.length, 0); // neither failed, so neither cleaned up — no duplicate object left behind
  assertEquals(stored.size, 1); // exactly one object ever exists for this hash — Phase 6 step 12
});

// ── service-role RPC execution authority (static source verification) ───

Deno.test("service-role RPC execution authority: the migration explicitly GRANTs EXECUTE on both mutation RPCs to service_role only, and REVOKEs from PUBLIC/anon/authenticated", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260915100000_financial_statement_documents.sql", import.meta.url),
  );
  for (const fnSig of [
    "public.intake_financial_statement_document(UUID, INTEGER, UUID, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT)",
    "public.advance_financial_statement_document_status(UUID, TEXT)",
  ]) {
    assert(sql.includes(`GRANT EXECUTE ON FUNCTION ${fnSig} TO service_role;`), `missing service_role GRANT for ${fnSig}`);
    assert(sql.includes(`REVOKE ALL ON FUNCTION ${fnSig} FROM PUBLIC, anon, authenticated;`), `missing REVOKE for ${fnSig}`);
  }
});
