// Email-status truthfulness and real-mailbox acceptance readiness. "Accepted by the email provider" is a different fact from
// "delivered", queued/processing/failed/bounced are different again, and nothing here may blur them. No email is sent: every
// transport is a fake, and an in-memory outbox mirrors the database's claim/complete semantics (the database itself is proven
// against real PostgreSQL in scripts/db-proof/serviceEnquiries.mjs). Identities are synthetic.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: vi.fn() }, rpc: vi.fn() } }));

import {
  NOTIFICATION_STATUSES,
  NOTIFICATION_TRANSITIONS,
  acknowledgementFor,
  isNotificationStatus,
  isValidNotificationTransition,
  type NotificationStatus,
} from "../../../supabase/functions/_shared/serviceEnquiryContract";
import {
  dispatchClaimed,
  handleDispatchNotifications,
  handleSubmitEnquiry,
  type ClaimedNotification,
  type DispatchDeps,
  type RpcResult,
} from "../../../supabase/functions/_shared/serviceEnquiryHandler";
import { buildRequesterAcknowledgement, buildStaffNotification, isNonDeliverableAddress, notificationIdempotencyKey } from "../../../supabase/functions/_shared/serviceEnquiryEmail";
import { ACKNOWLEDGEMENT_COPY } from "./copy";
import { NOTIFICATION_STATUS_LABELS, notificationFailureNote, notificationStatusLabel } from "./staffQueue";
import { NotificationChip } from "@/components/enquiry/queue/StatusBadge";

const REFERENCE = "CFQ-C63D-C27A-D191";
const REAL_MAILBOX = "requester@fixture-mail.dev"; // fake transport only: nothing is ever sent
const INTERNAL = "triage@fixture-mail.dev";
const KEY = "0b2f3c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";

// ── an in-memory outbox with the SAME rules as the SQL functions ─────────────────────────────────────────────────────────

interface Row {
  id: string;
  enquiryId: string;
  kind: ClaimedNotification["kind"];
  status: NotificationStatus;
  attempts: number;
  lastAttemptAt: number;
  code: string | null;
  providerId: string | null;
  email: string | null;
}

function outbox(opts: { ackEmail?: string } = {}) {
  const now = { t: 1_000_000 };
  const transitions: string[] = [];
  const rows: Row[] = [
    { id: "n-ack", enquiryId: "e1", kind: "requester_acknowledgement", status: "queued", attempts: 0, lastAttemptAt: 0, code: null, providerId: null, email: opts.ackEmail ?? REAL_MAILBOX },
    { id: "n-staff", enquiryId: "e1", kind: "staff_notification", status: "queued", attempts: 0, lastAttemptAt: 0, code: null, providerId: null, email: null },
  ];
  const move = (r: Row, to: NotificationStatus) => {
    if (r.status !== to) {
      expect(isValidNotificationTransition(r.status, to), `${r.status} -> ${to}`).toBe(true);
      transitions.push(`${r.kind}:${r.status}->${to}`);
      r.status = to;
    }
  };
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>): Promise<RpcResult> => {
    if (fn === "enquiry_notification_claim") {
      const due = rows.filter((r) => r.attempts < 5 && (r.status === "queued" ? now.t - r.lastAttemptAt >= 5 * 60_000 || r.lastAttemptAt === 0 : r.status === "processing" && now.t - r.lastAttemptAt >= 10 * 60_000));
      for (const r of due) {
        move(r, "processing");
        r.attempts += 1;
        r.lastAttemptAt = now.t;
      }
      return {
        data: due.map((r) => ({ id: r.id, kind: r.kind, attempt: r.attempts, reference: REFERENCE, service_code: "general", source_context: "contact_page", country_code: null, requester_email: r.kind === "requester_acknowledgement" ? r.email : null, requester_name: null })),
        error: null,
      };
    }
    if (fn === "enquiry_notification_complete") {
      const r = rows.find((x) => x.id === args.p_id);
      if (!r) return { data: null, error: { code: "P0002" } };
      if (r.status !== "processing") return { data: { status: r.status, changed: false }, error: null };
      const outcome = String(args.p_outcome);
      if (outcome === "accepted") {
        move(r, "accepted");
        r.providerId = (args.p_provider_message_id as string | null) ?? null;
        r.code = null;
      } else if (outcome === "failed" || (outcome === "retry" && r.attempts >= 5)) {
        move(r, "failed");
        r.code = (args.p_error_code as string | null) ?? "DELIVERY_FAILED";
      } else {
        move(r, "queued");
        r.code = (args.p_error_code as string | null) ?? "DELIVERY_RETRY";
        if (outcome === "blocked") r.attempts = Math.max(0, r.attempts - 1);
      }
      return { data: { status: r.status, changed: true }, error: null };
    }
    return { data: null, error: null };
  });
  return { rows, rpc, now, transitions, byKind: (k: Row["kind"]) => rows.find((r) => r.kind === k) as Row };
}

function depsFor(o: ReturnType<typeof outbox>, sendEmail: DispatchDeps["sendEmail"] | undefined, internalRecipient: string | null = INTERNAL): DispatchDeps {
  return {
    rpc: o.rpc,
    log: () => undefined,
    verifyUserId: async () => null,
    hmacHex: async () => "0".repeat(64),
    correlationId: () => "enq-test",
    sendEmail,
    internalRecipient,
    emailTimeoutMs: 100,
    challenge: { provider: "test", verify: async () => ({ kind: "passed" }) },
    isPlatformStaff: async () => true,
  };
}
const staffRequest = () => new Request("https://fn.test/dispatch-enquiry-notifications", { method: "POST", headers: { authorization: "Bearer a.b.c" } });
const dispatch = async (o: ReturnType<typeof outbox>, send: DispatchDeps["sendEmail"] | undefined, internal?: string | null) => {
  const res = await handleDispatchNotifications(staffRequest(), depsFor(o, send, internal));
  return (await res.json()) as Record<string, number>;
};

describe("the status model keeps six different facts apart", () => {
  it("has exactly queued, processing, accepted, delivered, failed and bounced", () => {
    expect([...NOTIFICATION_STATUSES]).toEqual(["queued", "processing", "accepted", "delivered", "failed", "bounced"]);
    for (const s of NOTIFICATION_STATUSES) expect(isNotificationStatus(s)).toBe(true);
    for (const s of ["pending", "sent", "delivered ", "", null, undefined, 7]) expect(isNotificationStatus(s), String(s)).toBe(false);
  });

  it("the transition graph is exactly: queued->processing, processing->accepted|queued|failed, accepted->delivered|bounced", () => {
    expect(NOTIFICATION_TRANSITIONS).toEqual({
      queued: ["processing"],
      processing: ["accepted", "queued", "failed"],
      accepted: ["delivered", "bounced"],
      delivered: [],
      failed: [],
      bounced: [],
    });
    // DELIVERY IS NEVER INFERRED: nothing reachable from a send attempt goes straight to delivered or bounced
    for (const from of ["queued", "processing", "failed"] as const) {
      expect(isValidNotificationTransition(from, "delivered"), from).toBe(false);
      expect(isValidNotificationTransition(from, "bounced"), from).toBe(false);
    }
    expect(isValidNotificationTransition("accepted", "delivered")).toBe(true); // only via a verified provider event (the database refuses it otherwise)
    expect(isValidNotificationTransition("accepted", "queued")).toBe(false);
    expect(isValidNotificationTransition("failed", "queued")).toBe(false); // terminal
    expect(isValidNotificationTransition("delivered", "failed")).toBe(false);
  });

  it("the requester-facing state calls acceptance 'sent' — never delivered — and never claims more than is known", () => {
    expect(acknowledgementFor("queued")).toBe("pending");
    expect(acknowledgementFor("processing")).toBe("pending");
    expect(acknowledgementFor("accepted")).toBe("sent");
    expect(acknowledgementFor("delivered")).toBe("sent");
    expect(acknowledgementFor("failed")).toBe("unavailable");
    expect(acknowledgementFor("bounced")).toBe("unavailable");
    expect(acknowledgementFor(null)).toBe("unavailable");
  });
});

describe("provider acceptance is not delivery", () => {
  it("a successful send is recorded as ACCEPTED with the provider's id; no code path records 'delivered'", async () => {
    const o = outbox();
    const send = vi.fn(async () => ({ providerMessageId: "prov-1" }));
    expect(await dispatch(o, send)).toEqual({ claimed: 2, accepted: 2, retry: 0, failed: 0, blocked: 0 });
    expect(o.rows.map((r) => r.status)).toEqual(["accepted", "accepted"]);
    expect(o.rows.some((r) => (r.status as string) === "delivered")).toBe(false);
    expect(o.byKind("requester_acknowledgement").providerId).toBe("prov-1");
    expect(o.transitions).toEqual(["requester_acknowledgement:queued->processing", "staff_notification:queued->processing", "requester_acknowledgement:processing->accepted", "staff_notification:processing->accepted"]);
  });

  it("the dispatch outcome vocabulary contains 'accepted' and has no 'sent' or 'delivered'", async () => {
    const o = outbox();
    const outcomes = await dispatchClaimed(((await o.rpc("enquiry_notification_claim", {})).data as ClaimedNotification[]), depsFor(o, async () => ({ providerMessageId: "p" })));
    expect(outcomes.map((x) => x.outcome)).toEqual(["accepted", "accepted"]);
    for (const x of outcomes) expect(["accepted", "retry", "failed", "blocked"]).toContain(x.outcome);
  });

  it("the public receipt says the provider ACCEPTED an acknowledgement — never that it was delivered or received", async () => {
    const o = outbox();
    const deps = depsFor(o, async () => ({ providerMessageId: "p" }));
    const post = new Request("https://fn.test/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schema_version: 1, idempotency_key: KEY, service_code: "general", source_context: "contact_page", name: "Ada Example", email: REAL_MAILBOX, subject: "A question about reporting", message: "A sufficiently long message body.", privacy_acknowledged: true, challenge_token: "t" }) });
    deps.rpc = vi.fn(async (fn, args) => (fn === "submit_service_enquiry" ? { data: { outcome: "created", reference: REFERENCE, submitted_at: "2026-09-21T08:00:00.000Z", status: "submitted", acknowledgement: "pending", enquiry_id: "e1" }, error: null } : o.rpc(fn, args)));
    const res = await handleSubmitEnquiry(post, deps);
    expect(((await res.json()) as { acknowledgement: string }).acknowledgement).toBe("sent");
    for (const text of Object.values(ACKNOWLEDGEMENT_COPY)) expect(text, text).not.toMatch(/\bdeliver(ed|y confirmed)\b|in your inbox|has arrived|was received by you/i);
    expect(ACKNOWLEDGEMENT_COPY.sent).toMatch(/provider has accepted/i);
    expect(ACKNOWLEDGEMENT_COPY.sent).toMatch(/not guaranteed/i);
    expect(ACKNOWLEDGEMENT_COPY.pending).toMatch(/queued and has not been sent yet/i);
    expect(ACKNOWLEDGEMENT_COPY.pending).not.toMatch(/\bsent to\b/i);
    expect(ACKNOWLEDGEMENT_COPY.unavailable).toMatch(/not available/i);
  });

  it("a queued or failed acknowledgement is never reported to the requester as sent", () => {
    for (const s of ["queued", "processing", "failed", "bounced"] as const) expect(acknowledgementFor(s)).not.toBe("sent");
  });
});

describe("the internal queue distinguishes queued, processing, accepted, delivered, failed and bounced", () => {
  const chip = (state: string | null) => renderToStaticMarkup(createElement(NotificationChip, { label: "Ack", state }));

  it("each state has its own word, and 'accepted' is worded as acceptance by the provider", () => {
    expect(NOTIFICATION_STATUS_LABELS).toEqual({
      queued: "queued",
      processing: "processing",
      accepted: "accepted by email provider",
      delivered: "delivered (confirmed)",
      failed: "failed",
      bounced: "bounced",
    });
    expect(new Set(Object.values(NOTIFICATION_STATUS_LABELS)).size).toBe(6);
    expect(notificationStatusLabel(null)).toBe("none");
    expect(notificationStatusLabel("something-new")).toBe("something-new");
  });

  it("the rendered chip shows the exact state; 'accepted' never reads as sent or delivered", () => {
    expect(chip("queued")).toContain("Ack: queued");
    expect(chip("processing")).toContain("Ack: processing");
    expect(chip("accepted")).toContain("Ack: accepted by email provider");
    expect(chip("accepted")).not.toMatch(/deliver|>sent|: sent/i);
    expect(chip("failed")).toContain("Ack: failed");
    expect(chip("bounced")).toContain("Ack: bounced");
    expect(chip("delivered")).toContain("delivered (confirmed)");
    expect(chip("accepted")).toContain('data-state="accepted"');
    expect(chip(null)).toContain("Ack: none");
  });

  it("the legacy words 'pending' and 'sent' are gone from the queue's vocabulary", () => {
    expect(Object.keys(NOTIFICATION_STATUS_LABELS)).not.toContain("pending");
    expect(Object.keys(NOTIFICATION_STATUS_LABELS)).not.toContain("sent");
  });

  it("failure notes explain the reason in words and never imply delivery", () => {
    expect(notificationFailureNote(null)).toBeNull();
    expect(notificationFailureNote("NON_DELIVERABLE_TEST_ADDRESS")).toMatch(/reserved test address/);
    expect(notificationFailureNote("EMAIL_NOT_CONFIGURED")).toMatch(/not configured/);
    for (const c of ["PROVIDER_TIMEOUT", "PROVIDER_ERROR", "LEASE_EXPIRED", "NON_DELIVERABLE_TEST_ADDRESS", "EMAIL_NOT_CONFIGURED", "OTHER"]) expect(notificationFailureNote(c), c).not.toMatch(/delivered/i);
  });
});

describe("reserved test addresses are a recorded test failure, never a successful delivery", () => {
  it("recognises .test/.example/.invalid/.localhost/.local and the example.* domains — and nothing real", () => {
    for (const a of ["a@b.test", "a@x.y.test", "a@corp.example", "a@x.invalid", "a@host.localhost", "a@printer.local", "a@example.com", "a@mail.example.org", "A@EXAMPLE.NET", "a@b.test."]) expect(isNonDeliverableAddress(a), a).toBe(true);
    for (const a of ["ada@fixture-mail.dev", "ada@cfoclose.com", "ada@testing.io", "ada@notexample.com", "ada@example.com.au", "ada@contest.org", "no-at-sign"]) expect(isNonDeliverableAddress(a), a).toBe(false);
  });

  it("a .test requester is NEVER sent to: the acknowledgement fails with a code, the provider is not called, and the receipt says unavailable", async () => {
    const o = outbox({ ackEmail: "someone@synthetic.test" });
    const send = vi.fn(async () => ({ providerMessageId: "p" }));
    expect(await dispatch(o, send)).toEqual({ claimed: 2, accepted: 1, retry: 0, failed: 1, blocked: 0 });
    expect(send).toHaveBeenCalledTimes(1); // only the internal notice
    expect(send.mock.calls.every((c) => (c as unknown as [{ to: string }])[0].to === INTERNAL)).toBe(true);
    const ack = o.byKind("requester_acknowledgement");
    expect(ack.status).toBe("failed");
    expect(ack.code).toBe("NON_DELIVERABLE_TEST_ADDRESS");
    expect(ack.providerId).toBeNull();
    expect(acknowledgementFor(ack.status)).toBe("unavailable");
  });

  it("a .test internal recipient fails the internal notice without touching the requester's acknowledgement", async () => {
    const o = outbox();
    const send = vi.fn(async () => ({ providerMessageId: "p" }));
    expect(await dispatch(o, send, "triage@synthetic.test")).toEqual({ claimed: 2, accepted: 1, retry: 0, failed: 1, blocked: 0 });
    expect(o.byKind("requester_acknowledgement").status).toBe("accepted");
    expect(o.byKind("staff_notification")).toMatchObject({ status: "failed", code: "NON_DELIVERABLE_TEST_ADDRESS" });
  });
});

describe("one recipient's failure never corrupts the other, and a retry never duplicates either", () => {
  const failFor = (kind: "ack" | "staff") =>
    vi.fn(async (m: { to: string }) => {
      if ((kind === "ack" && m.to === REAL_MAILBOX) || (kind === "staff" && m.to === INTERNAL)) throw new Error(`provider refused ${m.to}`);
      return { providerMessageId: `prov-${m.to}` };
    });

  it("the requester acknowledgement fails transiently while the internal notice is accepted — each row keeps its OWN outcome", async () => {
    const o = outbox();
    const send = failFor("ack");
    expect(await dispatch(o, send as DispatchDeps["sendEmail"])).toEqual({ claimed: 2, accepted: 1, retry: 1, failed: 0, blocked: 0 });
    expect(o.byKind("requester_acknowledgement")).toMatchObject({ status: "queued", code: "PROVIDER_ERROR", providerId: null });
    expect(o.byKind("staff_notification")).toMatchObject({ status: "accepted", code: null, providerId: `prov-${INTERNAL}` });
    expect(JSON.stringify(o.rows)).not.toMatch(/provider refused/); // provider text (which may echo an address) is never stored
  });

  it("the internal notice fails while the acknowledgement is accepted", async () => {
    const o = outbox();
    expect(await dispatch(o, failFor("staff") as DispatchDeps["sendEmail"])).toEqual({ claimed: 2, accepted: 1, retry: 1, failed: 0, blocked: 0 });
    expect(o.byKind("requester_acknowledgement")).toMatchObject({ status: "accepted", providerId: `prov-${REAL_MAILBOX}` });
    expect(o.byKind("staff_notification")).toMatchObject({ status: "queued", code: "PROVIDER_ERROR" });
  });

  it("a timeout on one is a recorded PROVIDER_TIMEOUT and does not stall or change the other", async () => {
    const o = outbox();
    const send = vi.fn(async (m: { to: string }) => (m.to === REAL_MAILBOX ? new Promise<never>(() => undefined) : { providerMessageId: "p" }));
    expect(await dispatch(o, send as unknown as DispatchDeps["sendEmail"])).toEqual({ claimed: 2, accepted: 1, retry: 1, failed: 0, blocked: 0 });
    expect(o.byKind("requester_acknowledgement").code).toBe("PROVIDER_TIMEOUT");
    expect(o.byKind("staff_notification").status).toBe("accepted");
  });

  it("DUPLICATE DISPATCH sends nothing: a second and a concurrent dispatch find no claimable row", async () => {
    const o = outbox();
    const send = vi.fn(async () => ({ providerMessageId: "p" }));
    await dispatch(o, send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(await dispatch(o, send)).toEqual({ claimed: 0, accepted: 0, retry: 0, failed: 0, blocked: 0 });
    expect(send).toHaveBeenCalledTimes(2);
    // concurrent dispatchers over fresh rows: the claim is exclusive, so each message is attempted once in total
    const c = outbox();
    const csend = vi.fn(async () => ({ providerMessageId: "p" }));
    await Promise.all([dispatch(c, csend), dispatch(c, csend), dispatch(c, csend)]);
    expect(csend).toHaveBeenCalledTimes(2);
    expect(c.rows.every((r) => r.status === "accepted" && r.attempts === 1)).toBe(true);
  });

  it("a late or duplicate completion of a row that is no longer in flight changes nothing", async () => {
    const o = outbox();
    await dispatch(o, async () => ({ providerMessageId: "first" }));
    const again = await o.rpc("enquiry_notification_complete", { p_id: "n-ack", p_outcome: "failed", p_provider_message_id: null, p_error_code: "LATE" });
    expect(again.data).toEqual({ status: "accepted", changed: false });
    expect(o.byKind("requester_acknowledgement")).toMatchObject({ status: "accepted", providerId: "first", code: null });
  });

  it("RETRY transitions are valid: failure re-queues, the retry after the wait is accepted, and the attempt limit ends in failed", async () => {
    const o = outbox();
    let ok = false;
    const send = vi.fn(async () => {
      if (!ok) throw new Error("down");
      return { providerMessageId: "p" };
    });
    await dispatch(o, send);
    expect(o.rows.map((r) => r.status)).toEqual(["queued", "queued"]);
    expect(await dispatch(o, send)).toMatchObject({ claimed: 0 }); // not due yet: the retry waits
    o.now.t += 6 * 60_000;
    ok = true;
    expect(await dispatch(o, send)).toEqual({ claimed: 2, accepted: 2, retry: 0, failed: 0, blocked: 0 });
    expect(o.transitions).toContain("requester_acknowledgement:queued->processing");
    expect(o.transitions).toContain("requester_acknowledgement:processing->queued");
    expect(o.transitions.filter((t) => t.startsWith("requester_acknowledgement:")).slice(-2)).toEqual(["requester_acknowledgement:queued->processing", "requester_acknowledgement:processing->accepted"]);

    const exhausted = outbox();
    const never = vi.fn(async () => Promise.reject(new Error("down")));
    for (let i = 0; i < 6; i += 1) {
      await dispatch(exhausted, never as DispatchDeps["sendEmail"]);
      exhausted.now.t += 6 * 60_000;
    }
    expect(exhausted.rows.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(exhausted.rows.every((r) => r.attempts === 5)).toBe(true);
    expect(never).toHaveBeenCalledTimes(10);
  });

  it("'not configured' is not a failure: rows return to queued and no attempt is charged", async () => {
    const o = outbox();
    expect(await dispatch(o, undefined)).toEqual({ claimed: 2, accepted: 0, retry: 0, failed: 0, blocked: 2 });
    expect(o.rows.every((r) => r.status === "queued" && r.attempts === 0 && r.code === "EMAIL_NOT_CONFIGURED")).toBe(true);
  });

  it("a crashed dispatcher's row (processing past its lease) is claimed again — and the provider de-duplicates on the same identity", async () => {
    const o = outbox();
    await o.rpc("enquiry_notification_claim", {}); // claimed, then the dispatcher dies before completing
    expect(o.rows.every((r) => r.status === "processing")).toBe(true);
    expect(await dispatch(o, vi.fn(async () => ({ providerMessageId: "p" })) as DispatchDeps["sendEmail"])).toMatchObject({ claimed: 0 }); // lease still held
    o.now.t += 11 * 60_000;
    const seen: string[] = [];
    await dispatch(o, vi.fn(async (m: { idempotencyKey: string }) => (seen.push(m.idempotencyKey), { providerMessageId: "p" })) as unknown as DispatchDeps["sendEmail"]);
    expect(o.rows.map((r) => r.status)).toEqual(["accepted", "accepted"]);
    expect(seen).toEqual([notificationIdempotencyKey("requester_acknowledgement", "n-ack"), notificationIdempotencyKey("staff_notification", "n-staff")]);
  });
});

describe("real-mailbox acceptance support: one acknowledgement, one internal notification, independent identities", () => {
  it("each notification has its own idempotency identity, stable across retries and different between the two", () => {
    const ack = buildRequesterAcknowledgement({ reference: REFERENCE, to: REAL_MAILBOX, notificationId: "n-ack" });
    const staff = buildStaffNotification({ reference: REFERENCE, serviceCode: "general", countryCode: null, sourceContext: "contact_page", to: INTERNAL, notificationId: "n-staff" });
    expect(ack.idempotencyKey).toBe("cfoclose-enquiry:requester_acknowledgement:n-ack");
    expect(staff.idempotencyKey).toBe("cfoclose-enquiry:staff_notification:n-staff");
    expect(ack.idempotencyKey).not.toBe(staff.idempotencyKey);
    const again = buildRequesterAcknowledgement({ reference: REFERENCE, to: REAL_MAILBOX, notificationId: "n-ack" });
    expect(again.idempotencyKey).toBe(ack.idempotencyKey); // a retry re-sends under the SAME key, so the provider drops the duplicate
    // even if two rows ever shared an id, their kinds keep the identities apart
    expect(notificationIdempotencyKey("requester_acknowledgement", "x")).not.toBe(notificationIdempotencyKey("staff_notification", "x"));
  });

  it("a real send attempt carries exactly the key, the recipient and no enquiry free text; the internal notice carries no requester data", async () => {
    const o = outbox();
    const sent: { to: string; idempotencyKey: string; text: string; html: string }[] = [];
    await dispatch(o, (async (m: { to: string; idempotencyKey: string; text: string; html: string }) => (sent.push(m), { providerMessageId: "p" })) as unknown as DispatchDeps["sendEmail"]);
    expect(sent.map((m) => m.to)).toEqual([REAL_MAILBOX, INTERNAL]);
    expect(new Set(sent.map((m) => m.idempotencyKey)).size).toBe(2);
    expect(sent[1].text + sent[1].html).not.toContain(REAL_MAILBOX);
  });

  it("an enquiry gets exactly one row per kind — a database uniqueness rule, not a convention", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const sql = fs.readFileSync(path.resolve(__dirname, "../../../supabase/migrations/20260921100000_service_enquiry_intake.sql"), "utf8");
    expect(sql).toMatch(/CONSTRAINT uq_service_enquiry_notification_kind UNIQUE \(enquiry_id, kind\)/);
    expect(sql.match(/INSERT INTO public\.service_enquiry_notifications \(enquiry_id, kind\) VALUES/g)?.length).toBe(2);
  });
});
