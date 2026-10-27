// Full chain, then the explicitly UNAPPLIED candidate. Disposable loopback database only; no hosted settings.
import fs from "node:fs";
import {
  applyChain,
  makeWorld,
  certifier,
  prepareReporting,
  openDatabase,
  reporter,
  uuid,
  REPO,
} from "./lib/reportingKit.mjs";
const { group, check, refused, finish } = reporter();
let db,
  crashed = false;
try {
  db = await openDatabase("equipment_preparation_proof");
  await check(
    "current full chain applies",
    async () => (await applyChain(db)) ?? true,
  );
  const W = await makeWorld(db),
    { U, A, B } = W;
  await W.rollout(A, true);
  await W.rollout(B, true);
  const k = await certifier(db, U);
  await prepareReporting(db, W, k);
  await check(
    "candidate installs only in this throwaway database",
    async () => {
      await db.admin.query(
        fs.readFileSync(
          `${REPO}/release/candidates/guided-equipment-r1/workpaper.sql`,
          "utf8",
        ),
      );
      return true;
    },
  );
  const compose = (
    await db.asUser(
      U.owner,
      "SELECT public.fs_statement_composition($1,2026) r",
      [A],
    )
  ).r;
  const payload = {
    contract: "cfoclose-equipment-workpaper/1",
    companyId: A,
    periodYear: 2026,
    compositionSha256: compose.compositionSha256,
    editor: { policy: { assetClass: "Equipment" } },
    priorSource: { fact: null },
    openingBridge: { openingMinor: "1600000" },
    schedule: {
      classLabel: "Equipment",
      closingMinor: "1400000",
      movements: [{ kind: "depreciation", amountMinor: "-200000" }],
    },
  };
  const context = (actor = U.preparer, company = A) =>
    db
      .asUser(actor, "SELECT public.fs_equipment_context($1,2026) r", [company])
      .then((x) => x.r);
  const save = (
    request,
    expected = null,
    p = payload,
    actor = U.preparer,
    company = A,
  ) =>
    db
      .asUser(
        actor,
        "SELECT public.fs_save_equipment_workpaper($1,2026,$2::jsonb,$3,NULL,$4) r",
        [company, JSON.stringify(p), expected, request],
      )
      .then((x) => x.r);
  group("Authority and append-only workpapers");
  await check(
    "viewer and outsider read no preparation data",
    async () =>
      (await context(U.viewer)).outcome === "forbidden" &&
      (await context(U.ownerB)).outcome === "forbidden",
  );
  await check(
    "cross-company save refused",
    async () =>
      (await save(uuid(), null, { ...payload, companyId: B }, U.preparer, B))
        .outcome === "forbidden",
  );
  await check(
    "wrong payload context refused",
    async () =>
      (await save(uuid(), null, { ...payload, companyId: B })).outcome ===
      "invalid_request",
  );
  const request = uuid();
  let receipt;
  await check(
    "twelve simultaneous identical saves record one immutable workpaper",
    async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, () => save(request)),
      );
      receipt = results[0];
      return (
        results.every(
          (r) =>
            r.outcome === "recorded" && r.workpaperId === receipt.workpaperId,
        ) &&
        results.filter((r) => !r.replay).length === 1 &&
        (await db.count(
          "SELECT count(*) n FROM public.fs_equipment_workpapers",
        )) === 1
      );
    },
  );
  await check(
    "missing original is not claimed retained",
    async () => receipt.sourceRetained === false,
  );
  await check(
    "changed payload cannot reuse request",
    async () =>
      (await save(request, null, { ...payload, extra: "different" }))
        .outcome === "request_reused",
  );
  await check(
    "stale editor cannot overwrite another version",
    async () => (await save(uuid())).outcome === "stale",
  );
  await check(
    "saved data can be read back",
    async () => (await context()).workpaper.id === receipt.workpaperId,
  );
  for (const verb of [
    "UPDATE public.fs_equipment_workpapers SET period_year=2025",
    "DELETE FROM public.fs_equipment_workpapers",
    "TRUNCATE public.fs_equipment_workpapers CASCADE",
  ])
    await refused(
      `owner cannot mutate history: ${verb.split(" ")[0]}`,
      "42501",
      () => db.admin.query(verb),
    );
  await refused(
    "policy insertion history cannot be truncated by the table owner",
    "42501",
    () => db.admin.query("TRUNCATE public.fs_equipment_policy_insertions"),
  );
  for (const role of ["anon", "service_role"])
    await refused(`${role} cannot call preparation context`, "42501", () =>
      db.asRole(role, null, "SELECT public.fs_equipment_context($1,2026)", [A]),
    );
  group("Policy insertion, stale refusal and idempotent receipts");
  const before = await context(),
    baseId = before.policy.id,
    body =
      before.policy.body +
      "\nEquipment: reviewed choices and supporting evidence.";
  const insert = (req, expected = baseId, text = body) =>
    db
      .asUser(
        U.preparer,
        "SELECT public.fs_record_reviewed_equipment_note($1,2026,$2,$3,$4,$5,'smes.note.policies') r",
        [A, receipt.workpaperId, expected, text, req],
      )
      .then((x) => x.r);
  const policyRequest = uuid();
  let policyReceipt;
  await check(
    "whole-note review records a new note preserving existing wording",
    async () => {
      policyReceipt = await insert(policyRequest);
      return (
        policyReceipt.outcome === "recorded" &&
        (await context()).policy.body === body
      );
    },
  );
  await check(
    "replay returns its receipt despite the now-new current note",
    async () => (await insert(policyRequest)).replay === true,
  );
  await check(
    "changed expected revision cannot reuse a request",
    async () =>
      (await insert(policyRequest, policyReceipt.textId)).outcome ===
      "request_reused",
  );
  await check(
    "stale new insertion does not overwrite another writer",
    async () =>
      (await insert(uuid())).outcome === "stale" &&
      (await context()).policy.body === body,
  );
  const fingerprint = JSON.stringify(
    (
      await db.admin.query(
        "SELECT * FROM public.fs_publication_bindings ORDER BY seq",
      )
    ).rows,
  );
  await check(
    "parallel edits against one revision have one winner and one stale refusal",
    async () => {
      const r = await Promise.all([
        insert(uuid(), policyReceipt.textId, body + " A"),
        insert(uuid(), policyReceipt.textId, body + " B"),
      ]);
      return (
        r.filter((x) => x.outcome === "recorded").length === 1 &&
        r.filter((x) => x.outcome === "stale").length === 1
      );
    },
  );
  await check("old source inputs cannot be inserted as current", async () => {
    const stale = await save(uuid(), receipt.workpaperId, {
      ...payload,
      compositionSha256: "0".repeat(64),
    });
    const c = await context();
    const r = (
      await db.asUser(
        U.preparer,
        "SELECT public.fs_record_reviewed_equipment_note($1,2026,$2,$3,$4,$5,'smes.note.policies') r",
        [A, stale.workpaperId, c.policy.id, body, uuid()],
      )
    ).r;
    return r.outcome === "stale_inputs";
  });
  await check(
    "publication binding history is unchanged (this fixture has no FINAL)",
    async () =>
      JSON.stringify(
        (
          await db.admin.query(
            "SELECT * FROM public.fs_publication_bindings ORDER BY seq",
          )
        ).rows,
      ) === fingerprint,
  );

  group("Atomic preparation commit");
  const atomicBase = await context();
  const atomicRequest = uuid(),
    atomicBody =
      atomicBase.policy.body + "\nAtomic reviewed preparation section.";
  const atomic = (
    request = atomicRequest,
    p = payload,
    expected = atomicBase.policy.id,
  ) =>
    db
      .asUser(
        U.preparer,
        "SELECT public.fs_commit_equipment_preparation($1,2026,$2::jsonb,$3,NULL,$4,$5,'smes.note.policies',$6,$7) r",
        [
          A,
          JSON.stringify(p),
          atomicBase.workpaper.id,
          expected,
          atomicBody,
          request,
          atomicBase.scheduleId,
        ],
      )
      .then((x) => x.r);
  await check(
    "twelve concurrent complete commits converge to one workpaper and matching note receipts",
    async () => {
      const r = await Promise.all(Array.from({ length: 12 }, () => atomic()));
      return r.every(
        (x) =>
          x.outcome === "recorded" &&
          x.workpaperId === r[0].workpaperId &&
          x.note.textId === r[0].note.textId,
      );
    },
  );
  const atomicCounts = async () =>
    JSON.stringify(
      (
        await db.admin.query(
          "SELECT (SELECT count(*) FROM public.fs_equipment_workpapers) w,(SELECT count(*) FROM public.fs_schedule_submissions) s,(SELECT count(*) FROM public.fs_disclosure_texts) t,(SELECT count(*) FROM public.fs_equipment_policy_insertions) n",
        )
      ).rows,
    );
  const allBefore = await atomicCounts();
  const atomicCurrent = await context();
  await check(
    "a refused schedule rolls back its newly inserted workpaper",
    async () => {
      const bad = {
        ...payload,
        schedule: {
          ...payload.schedule,
          movements: [{ kind: "depreciation", amountMinor: "-100000" }],
        },
      };
      const r = (
        await db.asUser(
          U.preparer,
          "SELECT public.fs_commit_equipment_preparation($1,2026,$2::jsonb,$3,NULL,$4,$5,'smes.note.policies',$6,$7) r",
          [
            A,
            JSON.stringify(bad),
            atomicCurrent.workpaper.id,
            atomicCurrent.policy.id,
            atomicBody,
            uuid(),
            atomicCurrent.scheduleId,
          ],
        )
      ).r;
      return (
        r.outcome === "invalid_schedule" && (await atomicCounts()) === allBefore
      );
    },
  );
  await check(
    "a stale note rolls back both the workpaper and schedule",
    async () => {
      const r = (
        await db.asUser(
          U.preparer,
          "SELECT public.fs_commit_equipment_preparation($1,2026,$2::jsonb,$3,NULL,$4,$5,'smes.note.policies',$6,$7) r",
          [
            A,
            JSON.stringify(payload),
            atomicCurrent.workpaper.id,
            atomicBase.policy.id,
            atomicBody,
            uuid(),
            atomicCurrent.scheduleId,
          ],
        )
      ).r;
      return r.outcome === "stale" && (await atomicCounts()) === allBefore;
    },
  );
  await check(
    "a newer schedule is refused before any atomic write",
    async () => {
      const r = (
        await db.asUser(
          U.preparer,
          "SELECT public.fs_commit_equipment_preparation($1,2026,$2::jsonb,$3,NULL,$4,$5,'smes.note.policies',$6,$7) r",
          [
            A,
            JSON.stringify(payload),
            atomicCurrent.workpaper.id,
            atomicCurrent.policy.id,
            atomicBody,
            uuid(),
            uuid(),
          ],
        )
      ).r;
      return (
        r.outcome === "stale_schedule" && (await atomicCounts()) === allBefore
      );
    },
  );
  group("Disclosure target, rollback and retained-source metadata");
  const noteContext = await context();
  await check(
    "equipment disclosure insertion preserves the existing broader note",
    async () => {
      const old = noteContext.equipmentNote,
        proposed =
          old.body +
          "\nEquipment gross amount and accumulated deductions: synthetic workpaper.";
      const r = (
        await db.asUser(
          U.preparer,
          "SELECT public.fs_record_reviewed_equipment_note($1,2026,$2,$3,$4,$5,'smes.note.subclassifications') r",
          [A, receipt.workpaperId, old.id, proposed, uuid()],
        )
      ).r;
      return (
        r.outcome === "recorded" &&
        (await context()).equipmentNote.body === proposed
      );
    },
  );
  const beforeFailure = await context();
  const rowCount = await db.count(
    "SELECT count(*) n FROM public.fs_disclosure_texts",
  );
  await db.admin.query(
    "CREATE FUNCTION public.equipment_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INJECTED_POLICY_FAILURE'; END; $$; CREATE TRIGGER equipment_test_fail BEFORE INSERT ON public.fs_equipment_policy_insertions FOR EACH ROW EXECUTE FUNCTION public.equipment_test_fail()",
  );
  await refused(
    "failure writing the receipt rolls back disclosure insertion too",
    "P0001",
    () =>
      db.asUser(
        U.preparer,
        "SELECT public.fs_record_reviewed_equipment_note($1,2026,$2,$3,$4,$5,'smes.note.policies')",
        [
          A,
          receipt.workpaperId,
          beforeFailure.policy.id,
          "Fault injection must leave no note behind",
          uuid(),
        ],
      ),
    "INJECTED_POLICY_FAILURE",
  );
  await db.admin.query(
    "DROP TRIGGER equipment_test_fail ON public.fs_equipment_policy_insertions; DROP FUNCTION public.equipment_test_fail()",
  );
  await check(
    "failed insertion changed neither current note nor disclosure history",
    async () =>
      (await context()).policy.id === beforeFailure.policy.id &&
      (await db.count("SELECT count(*) n FROM public.fs_disclosure_texts")) ===
        rowCount,
  );
  const member = (
    await db.one(
      "SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2",
      [A, U.preparer],
    )
  ).id;
  const sourceId = (
    await db.one(
      "INSERT INTO public.financial_statement_documents(company_id,period_year,uploaded_by_firm_member_id,original_file_name,mime_type,byte_size,sha256,artifact_class,status,storage_path) VALUES($1,2025,$2,'synthetic-prior.pdf','application/pdf',10,$3,'financial_statements','STORED',$4) RETURNING id",
      [A, member, "a".repeat(64), `${A}/2025/synthetic-source`],
    )
  ).id;
  const currentWork = (await context()).workpaper.id;
  const attach = async (sha) =>
    (
      await db.asUser(
        U.preparer,
        "SELECT public.fs_save_equipment_workpaper($1,2026,$2::jsonb,$3,$4,$5) r",
        [
          A,
          JSON.stringify({
            ...payload,
            priorSource: { fact: { documentSha256: sha } },
          }),
          currentWork,
          sourceId,
          uuid(),
        ],
      )
    ).r;
  await check(
    "a mismatched source digest is refused",
    async () => (await attach("b".repeat(64))).outcome === "source_mismatch",
  );
  await check(
    "retention flag follows an existing same-company source record with the same digest",
    async () => {
      const r = await attach("a".repeat(64));
      return r.outcome === "recorded" && r.sourceRetained === true;
    },
  );
  await check("one-class atomic commit cannot erase a multi-class schedule", async () => {
    const rows = ["Equipment", "Vehicles"].map(classLabel => ({classLabel, openingMinor:"800000", closingMinor:"700000", movements:[{kind:"depreciation",amountMinor:"-100000"}]}));
    const recorded = (await db.asUser(U.preparer, "SELECT public.fs_record_schedule($1,2026,'ppe',$2::jsonb,'Synthetic multi-class register',$3) r", [A, JSON.stringify(rows), uuid()])).r;
    if (recorded.outcome !== "recorded") return false;
    const c = await context(), before = await atomicCounts();
    const r = (await db.asUser(U.preparer, "SELECT public.fs_commit_equipment_preparation($1,2026,$2::jsonb,$3,NULL,$4,$5,'smes.note.policies',$6,$7) r", [A, JSON.stringify(payload), c.workpaper.id, c.policy.id, atomicBody, uuid(), c.scheduleId])).r;
    return r.outcome === "multi_class_schedule" && await atomicCounts() === before && (await context()).scheduleId === c.scheduleId;
  });
  await db.admin.query(
    "UPDATE public.firm_members SET accepted_at=NULL WHERE company_id=$1 AND user_id=$2",
    [A, U.preparer],
  );
  await check(
    "revoked preparer cannot read saved workpapers",
    async () => (await context()).outcome === "forbidden",
  );
} catch (e) {
  crashed = true;
  console.error(e.stack ?? e);
}
const ok = finish("EQUIPMENT_PREPARATION", crashed);
await db?.close();
process.exit(ok ? 0 : 1);
