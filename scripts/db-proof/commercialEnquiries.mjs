#!/usr/bin/env bun
// Real-PostgreSQL proof of the commercial enquiry additions (20261025100000), through the REAL Edge handler code
// (supabase/functions/_shared/serviceEnquiryHandler.ts) with only the outside world injected: the local-stack challenge
// bypass the code already ships, a keyed hash, and a capturing email sender in place of the provider.
//
//   services     plan activation (a named catalogue plan, required and enumerated) and the five specialist services
//                submit through the one handler; an unknown plan or a missing one is refused by the contract AND the
//                database; the existing services are unchanged
//   replies      only ACTIVE platform staff reply (non-staff and anonymous refused); a reply is stored append-only, put on
//                the timeline and queued as its own outbox row; a retry of the same request queues nothing new; a reused
//                request with other text is refused; no reply to spam/withdrawn
//   dispatch     the dispatcher sends the reply to the requester's own address with the body and reference; the row is
//                "accepted" (provider acceptance, never "delivered"); a provider failure leaves it queued for retry with a code
//   isolation    replies are not readable by any client role; staff detail shows each reply's own delivery state
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/commercialEnquiries.mjs
import crypto from "node:crypto";
import { applyChain, openDatabase, reporter, uuid } from "./lib/reportingKit.mjs";
import { handleSubmitEnquiry, dispatchClaimed } from "../../supabase/functions/_shared/serviceEnquiryHandler.ts";
import { createLocalBypassVerifier } from "../../supabase/functions/_shared/serviceEnquiryChallenge.ts";

const { group, check, finish } = reporter();
let db;

async function main() {
  db = await openDatabase("commercial_enquiries_proof");
  group("Replay");
  await check("the whole chain applies", async () => (await applyChain(db)) ?? true);

  const sigs = new Map();
  const rpcAs = (role, uid) => async (fn, args) => {
    if (!sigs.has(fn)) {
      const r = await db.one(`SELECT p.proargnames AS names, array(SELECT format_type(t, NULL) FROM unnest(p.proargtypes) t) AS types FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1 ORDER BY p.oid DESC LIMIT 1`, [fn]);
      sigs.set(fn, Object.fromEntries(r.names.slice(0, r.types.length).map((n, i) => [n, r.types[i]])));
    }
    const sig = sigs.get(fn), keys = Object.keys(args);
    try {
      const rows = await db.asRole(role, uid, `SELECT to_jsonb(public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}::${sig[k]}`).join(", ")})) AS r`,
        keys.map((k) => (sig[k] === "jsonb" && args[k] !== null ? JSON.stringify(args[k]) : args[k])));
      return { data: rows[0].r, error: null };
    } catch (e) { return { data: null, error: { message: e.message, code: e.code } }; }
  };
  const sent = [];
  let providerDown = false;
  const deps = {
    rpc: rpcAs("service_role", null),
    verifyUserId: async () => null,
    hmacHex: async (purpose, value) => crypto.createHmac("sha256", "proof-secret").update(`${purpose}:${value}`).digest("hex"),
    sendEmail: async (email) => { if (providerDown) throw new Error("provider down"); sent.push(email); return { providerMessageId: `msg-${sent.length}` }; },
    internalRecipient: "operator@proofops.co.tz",
    log: () => {},
    correlationId: () => uuid(),
    emailTimeoutMs: 2000,
    challenge: createLocalBypassVerifier(),
  };
  const submit = async (service, extra = {}) => {
    const body = { schema_version: 1, idempotency_key: uuid(), service_code: service, source_context: extra.source ?? "landing_plans", name: "Asha Mrema",
      email: extra.email ?? `asha.${service}.${crypto.randomUUID().slice(0, 6)}@proofclient.co.tz`, organization: "Proof Ltd", subject: `${service} request`, message: "We would like to discuss this with your team, please.",
      privacy_acknowledged: true, payload: extra.payload ?? {}, challenge_token: "local-proof-token" };
    const res = await handleSubmitEnquiry(new Request("http://localhost/functions/v1/submit-service-enquiry", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) }), deps);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const enquiryByRef = async (ref) => db.one("SELECT * FROM public.service_enquiries WHERE public_reference = $1", [ref]);

  group("Services: plan activation and the specialist services, through the real handler");
  let activation;
  await check("a plan activation request naming SOLO is accepted and stored with its plan; the acknowledgement goes to the requester", async () => {
    const r = await submit("plan_activation", { payload: { plan_code: "SOLO" }, email: "asha@proofclient.co.tz" });
    activation = r.body?.reference ? await enquiryByRef(r.body.reference) : null;
    const ack = sent.find((e) => e.subject.includes(r.body?.reference ?? "none") && e.to === "asha@proofclient.co.tz");
    return r.status === 200 || r.status === 201 ? (activation?.service_code === "plan_activation" && activation.payload.plan_code === "SOLO" && activation.source_context === "landing_plans" && ack ? true : { activation, ack: !!ack })
      : r;
  });
  await check("an activation request without a plan, or with a plan not in the catalogue, is refused by the contract; the database refuses it too", async () => {
    const a = await submit("plan_activation", { payload: {} });
    const b = await submit("plan_activation", { payload: { plan_code: "PLATINUM" } });
    let dbRefused = false;
    try {
      await db.admin.query(`INSERT INTO public.service_enquiries (public_reference, requester_name, requester_email, service_code, source_context, subject, message, payload_schema_version, payload, status, idempotency_key, request_fingerprint)
        VALUES ('CFQ-AAAA-BBBB-CCCC','X','x@proofclient.co.tz','plan_activation','landing_plans','Subject here','A message long enough.',1,'{}'::jsonb,'submitted',$1,$2)`, [uuid(), "a".repeat(64)]);
    } catch (e) { dbRefused = /chk_service_enquiries_payload/.test(e.message) || e.code === "23514"; }
    return a.status === 400 && b.status === 400 && dbRefused ? true : { a, b, dbRefused };
  });
  for (const code of ["forecasting", "budgeting", "financial_analysis", "accounting_policies", "close_support"]) {
    await check(`specialist service ${code} is accepted from the landing services entry point with no service payload`, async () => {
      const r = await submit(code, { source: "landing_services" });
      const e = r.body?.reference ? await enquiryByRef(r.body.reference) : null;
      return e?.service_code === code && e.source_context === "landing_services" && JSON.stringify(e.payload) === "{}" ? true : r;
    });
  }
  await check("a specialist service with a payload field is refused (no hidden fields)", async () => {
    const r = await submit("forecasting", { source: "landing_services", payload: { plan_code: "SOLO" } });
    return r.status === 400 ? true : r;
  });

  group("Tracked replies");
  const staffUid = uuid(), otherUid = uuid(), outsider = uuid();
  for (const [id, email] of [[staffUid, "agent@cfoclose-proof.example"], [otherUid, "agent2@cfoclose-proof.example"], [outsider, "customer@proofclient.co.tz"]])
    await db.admin.query("INSERT INTO auth.users (id, email) VALUES ($1, $2)", [id, email]);
  await check("platform staff are enrolled through the supported operator function (service role only)", async () => {
    const g = await rpcAs("service_role", null)("platform_staff_grant", { p_user_id: staffUid, p_staff_role: "triage_agent", p_reason: "Verified by the proof operator", p_operator_label: "proof-operator" });
    const viaUser = await rpcAs("authenticated", outsider)("platform_staff_grant", { p_user_id: outsider, p_staff_role: "manager", p_reason: "Self-enrolment attempt here", p_operator_label: "self" });
    return !g.error && viaUser.error?.code === "42501" ? true : { g, viaUser };
  });
  const reply = (uid, enquiryId, body, request) => rpcAs("authenticated", uid)("staff_reply_service_enquiry", { p_enquiry_id: enquiryId, p_body: body, p_request_id: request });
  let req1;
  await check("a signed-in non-staff user and an anonymous caller cannot reply (42501); nothing is stored", async () => {
    const a = await reply(outsider, activation.id, "Not allowed", uuid());
    const b = await rpcAs("anon", null)("staff_reply_service_enquiry", { p_enquiry_id: activation.id, p_body: "Not allowed", p_request_id: uuid() });
    const n = await db.count("SELECT count(*) n FROM public.service_enquiry_replies");
    return a.error?.code === "42501" && b.error && n === 0 ? true : { a, b, n };
  });
  await check("staff reply: stored, on the timeline, queued as its own outbox row; the same request again queues nothing new", async () => {
    req1 = uuid();
    const r = await reply(staffUid, activation.id, "Thank you — we can activate Solo after a short call.\nWhen suits you?", req1);
    const again = await reply(staffUid, activation.id, "Thank you — we can activate Solo after a short call.\nWhen suits you?", req1);
    const rows = await db.count("SELECT count(*) n FROM public.service_enquiry_replies WHERE enquiry_id=$1", [activation.id]);
    const outbox = (await db.admin.query("SELECT status FROM public.service_enquiry_notifications WHERE enquiry_id=$1 AND kind='staff_reply'", [activation.id])).rows;
    const ev = await db.count("SELECT count(*) n FROM public.service_enquiry_events WHERE enquiry_id=$1 AND event_kind='reply' AND actor_user_id=$2", [activation.id, staffUid]);
    return !r.error && again.data?.replay === true && rows === 1 && outbox.length === 1 && outbox[0].status === "queued" && ev === 1 ? true : { r, again, rows, outbox, ev };
  });
  await check("a reused request with other text is refused; a reply cannot be edited or deleted (append-only)", async () => {
    const c = await reply(staffUid, activation.id, "Different text", req1);
    let upd = "allowed"; try { await db.admin.query("UPDATE public.service_enquiry_replies SET body='edited'"); } catch (e) { upd = "refused"; }
    let del = "allowed"; try { await db.admin.query("DELETE FROM public.service_enquiry_replies"); } catch (e) { del = "refused"; }
    return c.error?.code === "23505" && upd === "refused" && del === "refused" ? true : { c, upd, del };
  });
  await check("no client role can read replies directly (anon, authenticated, even staff: only through the staff detail function)", async () => {
    const out = [];
    for (const [role, uid] of [["anon", null], ["authenticated", outsider], ["authenticated", staffUid]]) {
      try { await db.asRole(role, uid, "SELECT count(*) FROM public.service_enquiry_replies"); out.push("readable"); } catch (e) { out.push(e.code); }
    }
    return out.every((c) => c === "42501") ? true : out;
  });

  group("Dispatch: the reply reaches the requester's own address; the state is honest");
  await check("the dispatcher sends the reply to the requester with its body and reference; the row is 'accepted' (not 'delivered')", async () => {
    const claim = await deps.rpc("enquiry_notification_claim", { p_limit: 50, p_enquiry_id: activation.id });
    const rows = claim.data.filter((r) => r.kind === "staff_reply");
    const before = sent.length;
    await dispatchClaimed(rows, deps);
    const mail = sent.slice(before).find((e) => e.subject.startsWith("Re: your CFOClose enquiry"));
    const state = (await db.one("SELECT status, provider_message_id FROM public.service_enquiry_notifications WHERE enquiry_id=$1 AND kind='staff_reply'", [activation.id]));
    return rows.length === 1 && rows[0].reply_body?.startsWith("Thank you") && mail?.to === "asha@proofclient.co.tz" && mail.text.includes(activation.public_reference)
      && mail.text.includes("When suits you?") && state.status === "accepted" && state.provider_message_id ? true : { rows: rows.length, mail: mail && { to: mail.to }, state };
  });
  await check("the claim exposes the requester address and reply body only for requester-facing rows, never on the internal notice", async () => {
    const r = await submit("budgeting", { source: "landing_services", email: "bo@proofclient.co.tz" });
    const e = await enquiryByRef(r.body.reference);
    const claim = (await deps.rpc("enquiry_notification_claim", { p_limit: 50, p_enquiry_id: e.id })).data ?? [];
    const internal = claim.find((x) => x.kind === "staff_notification");
    await dispatchClaimed(claim, deps);
    return !internal || (internal.requester_email === null && internal.reply_body === null) ? true : internal;
  });
  await check("a provider failure leaves the reply queued with a code for retry; staff see that state in the detail", async () => {
    const r = await reply(staffUid, activation.id, "A second reply while the provider is down.", uuid());
    providerDown = true;
    const claim = (await deps.rpc("enquiry_notification_claim", { p_limit: 50, p_enquiry_id: activation.id })).data.filter((x) => x.kind === "staff_reply");
    await dispatchClaimed(claim, deps);
    providerDown = false;
    const detail = (await rpcAs("authenticated", staffUid)("staff_get_service_enquiry", { p_enquiry_id: activation.id })).data;
    const states = detail.replies.map((x) => `${x.delivery_status}:${x.last_error_code ?? ""}`);
    return !r.error && JSON.stringify(states) === '["accepted:","queued:PROVIDER_ERROR"]' && detail.notifications.every((n) => n.kind !== "staff_reply") ? true : states;
  });
  await check("no reply is sent to an enquiry marked spam", async () => {
    const r = await submit("close_support", { source: "landing_services", email: "spam@proofclient.co.tz" });
    const e = await enquiryByRef(r.body.reference);
    await rpcAs("authenticated", staffUid)("staff_transition_service_enquiry", { p_enquiry_id: e.id, p_to_status: "spam", p_expected_status: "submitted" });
    const x = await reply(staffUid, e.id, "Hello", uuid());
    return /no reply is sent/.test(x.error?.message ?? "") ? true : x;
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("COMMERCIAL_ENQUIRIES", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
