import { useBusyState } from "@/hooks/useBusyState";
import { ActionButton } from "@/components/feedback/ActionButton";
import { PendingStatus } from "@/components/feedback/Activity";
/**
 * The OFFICIAL Reporting Pack of a FINAL version — the existing server-sealed issuance (20260925120000/140000) reached
 * from the reporting workbench: the server issues a single-use issuance bound to the FINAL publication, generates the
 * canonical document itself, stores exactly those bytes (private bucket, no overwrite) and seals its own SHA-256; the
 * browser saves the server's document and never builds, uploads or hashes anything. Verify re-reads the stored bytes on
 * the server; Retrieve returns them again with their digest. The printable pack on this page is a RENDERING of the same
 * stored version, never the official artifact; an edited export carries no integrity claim.
 */
import { useCallback, useEffect, useState } from "react";
import { sha256HexOf, type Issuance } from "@/lib/reporting/reviewWorkflow";
import type { SavedVersion } from "@/lib/reporting/signoff";
import { Notice, useAttempt, type PageProps } from "./shared";

const DELIVERY_WORDS: Readonly<Record<string, string>> = {
  delivered: "The official pack is issued, stored and sealed by the server; the file saved is the server's document.",
  locked: "The account's plan does not include the official Reporting Pack.", not_permitted: "Your role cannot issue a Reporting Pack.",
  not_final: "Only a FINAL version can be issued officially.", failed: "We could not confirm delivery. Check the issued packs below; retrying this attempt uses the same request.",
};
const VERIFY_WORDS: Readonly<Record<string, string>> = {
  intact: "Verified: the stored bytes hash to the sealed digest and the seal is the canonical document of this version.",
  substituted: "WARNING: the stored bytes are not the sealed bytes.", not_canonical: "WARNING: the seal is not the canonical document of its source.",
  missing: "The stored object is missing.", not_found: "No such official pack for this workspace.", unavailable: "The server function is not reachable from this page.",
};

export function OfficialPack(p: PageProps & { v: SavedVersion }) {
  const outputRef = p.clients.review.outputRef(p.v.reportId, p.v.reportVersion);
  const [list, setList] = useState<Issuance[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useBusyState("Preparing or checking the official pack…");
  const [operation, setOperation] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const attempt = useAttempt(p.newRequestId);
  const [verdicts, setVerdicts] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    setReadError(null);
    try { setList(await p.clients.review.issuances(p.companyId, outputRef)); }
    catch { setReadError("The issued packs could not be read. Check the list before starting another issuance."); }
  }, [p.clients, p.companyId, outputRef]);
  useEffect(() => { void load().catch((e) => setNotice((e as Error).message)); }, [load]);
  const save = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = fileName; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const issue = async () => {
    if (!setBusy(true)) return;
    setOperation("issue");
    try {
      const r = await p.clients.review.issueOfficial(p.companyId, p.periodYear, outputRef, save, attempt.idFor(outputRef));
      if (r === "delivered") attempt.done();
      setNotice(DELIVERY_WORDS[r] ?? r);
      await load();
    } catch (e) { setNotice(`Could not confirm issuance: ${(e as Error).message}. Check the issued packs before starting another attempt.`); }
    finally { setBusy(false); setOperation(null); }
  };
  const verify = async (id: string) => {
    if (!setBusy(true)) return;
    setOperation(`verify:${id}`);
    try {
      const r = await p.clients.review.verify(id);
      setVerdicts((v) => ({ ...v, [id]: `${VERIFY_WORDS[r.outcome] ?? r.outcome}${r.official ? " Official." : ""}` }));
    } catch { setVerdicts((v) => ({ ...v, [id]: "Verification could not be completed. Try again." })); }
    finally { setBusy(false); setOperation(null); }
  };
  const resume = async (id: string) => {
    if (!setBusy(true)) return;
    setOperation(`resume:${id}`);
    try { setNotice(DELIVERY_WORDS[await p.clients.review.resumeOfficial(id, save)]); await load(); }
    catch { setNotice("Could not confirm delivery. This issuance is kept; check it again before starting another."); }
    finally { setBusy(false); setOperation(null); }
  };
  const retrieve = async (iss: Issuance) => {
    if (!setBusy(true)) return;
    setOperation(`retrieve:${iss.issuanceId}`);
    try {
    const r = await p.clients.review.retrieve(iss.issuanceId);
    if (r.outcome !== "retrieved" || !r.document || !r.content_sha256) { setVerdicts((v) => ({ ...v, [iss.issuanceId]: VERIFY_WORDS[r.outcome] ?? `Not retrieved (${r.outcome}).` })); return; }
    const local = await sha256HexOf(r.document);
    const same = local === r.content_sha256 && r.content_sha256 === iss.contentSha256;
    setVerdicts((v) => ({ ...v, [iss.issuanceId]: same ? `Retrieved again: ${r.document!.length} characters, digest ${r.content_sha256!.slice(0, 16)}… matches the seal recorded at issue.` : `WARNING: the retrieved bytes hash to ${local.slice(0, 16)}…, not the sealed ${String(iss.contentSha256).slice(0, 16)}….` }));
    if (same) save(new Blob([r.document], { type: "application/json" }), r.file_name ?? `official-pack-${iss.issuanceId.slice(0, 8)}.json`);
    } catch { setVerdicts((v) => ({ ...v, [iss.issuanceId]: "The pack could not be retrieved. Try again; the stored pack is unchanged." })); }
    finally { setBusy(false); setOperation(null); }
  };
  if (p.v.state !== "FINAL") return null;
  const sealed = (list ?? []).filter((i) => i.sealedAt);
  return (
    <section aria-labelledby="h-op" className="space-y-2 text-sm" data-testid="official-pack" data-sealed={sealed.length}>
      <h2 id="h-op" className="text-base font-semibold">Official Reporting Pack (server-sealed)</h2>
      <p className="text-muted-foreground">The canonical document of version {p.v.reportVersion}, generated, stored and sealed by the server and bound to this FINAL publication. The printable pack above is a rendering of the same version, not the official artifact.</p>
      {p.allowed.includes("issue_reporting_pack") ? (
        <ActionButton busy={operation === "issue"} busyLabel="Issuing pack…" type="button" className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50" disabled={busy || list === null || !!readError} onClick={() => void issue()} data-testid="issue-official">
          {sealed.length ? "Issue another official pack of this version" : "Issue the official pack"}
        </ActionButton>
      ) : <p className="text-muted-foreground">A member who may issue Reporting Packs issues the official pack.</p>}
      {readError && <p role="alert">{readError} <button type="button" className="underline" onClick={() => void load()}>Check again</button></p>}
      {(list ?? []).filter((i) => !i.sealedAt).map((i) => <div key={i.issuanceId} className="rounded-sm border border-border p-3">
        <p>An issuance was started; its seal has not been confirmed.</p>
        <ActionButton busy={operation === `resume:${i.issuanceId}`} busyLabel="Resuming issuance…" disabled={busy} className="mt-2 rounded-md border border-input px-3 py-1.5" onClick={() => void resume(i.issuanceId)}>Resume this issuance</ActionButton>
      </div>)}
      {list === null && !readError ? <PendingStatus label="Reading the issued packs…" /> : list === null ? null : sealed.length === 0 ? <p data-testid="no-official">No official pack of this version has been issued.</p> : (
        <ul className="space-y-1" data-testid="official-list">
          {sealed.map((i) => (
            <li key={i.issuanceId} data-testid="official-issuance" data-sha={i.contentSha256 ?? ""}>
              Issued {i.issuedAt.slice(0, 16).replace("T", " ")}, sealed {String(i.sealedAt).slice(0, 16).replace("T", " ")} · SHA-256 <code>{i.contentSha256}</code>
              <span className="ml-2 inline-flex gap-2">
                <ActionButton busy={operation === `verify:${i.issuanceId}`} busyLabel="Verifying…" disabled={busy} type="button" className="rounded-md border border-input px-2 py-0.5" onClick={() => void verify(i.issuanceId)} data-testid="verify-official">Verify on the server</ActionButton>
                <ActionButton busy={operation === `retrieve:${i.issuanceId}`} busyLabel="Retrieving…" disabled={busy} type="button" className="rounded-md border border-input px-2 py-0.5" onClick={() => void retrieve(i)} data-testid="retrieve-official">Retrieve again</ActionButton>
              </span>
              {verdicts[i.issuanceId] ? <p className="text-xs" data-testid="official-verdict">{verdicts[i.issuanceId]}</p> : null}
            </li>
          ))}
        </ul>
      )}
      <Notice text={notice} />
    </section>
  );
}
