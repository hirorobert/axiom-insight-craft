import { compileSavedReport } from "../_shared/statementCompiler.generated.mjs";
import { STATEMENT_COMPILER_SHA256 } from "../_shared/statementCompiler.manifest.mjs";
const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers });
const MAX_REQUEST_BYTES = 2048;
/** Bound the stream before buffering it; Content-Length is only an early refusal, never trusted as a limit. */
async function requestText(request: Request): Promise<string | null> {
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) { await reader.cancel(); return null; }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  } finally { reader.releaseLock(); }
}
type Result = { data: unknown; error: { message: string } | null };
interface UserClient {
  auth: { getUser(): Promise<{ data: { user: { id: string } | null }; error: unknown }> };
  rpc(name: string, args: Record<string, unknown>): PromiseLike<Result>;
  from(table: string): { select(columns: string): { match(filters: Record<string, unknown>): PromiseLike<Result> } };
}
interface Services {
  user(token: string): UserClient;
  service(): { rpc(name: string, args: Record<string, unknown>): PromiseLike<Result> };
  compile?: typeof compileSavedReport;
}
/** HTTP trust boundary. Factories are deployment dependencies; nothing in the request can select them or an actor. */
export function compilationHandler(services: Services) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { headers });
    if (request.method !== "POST") return reply(405, { error: "METHOD_NOT_ALLOWED" });
    const token = request.headers.get("Authorization"); if (!token?.startsWith("Bearer ")) return reply(401, { error: "UNAUTHENTICATED" });
    try {
      const user = services.user(token);
      const auth = await user.auth.getUser(); if (auth.error || !auth.data.user) return reply(401, { error: "UNAUTHENTICATED" });
      const text = await requestText(request); if (text === null) return reply(400, { error: "INVALID_REQUEST" });
      let p: Record<string, unknown>;
      try { p = JSON.parse(text); } catch { return reply(400, { error: "INVALID_REQUEST" }); }
      if (!p || Array.isArray(p) || typeof p !== "object" || Object.keys(p).some(k => !["companyId", "reportId", "reportVersion"].includes(k))
          || typeof p.companyId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.companyId)
          || typeof p.reportId !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(p.reportId)
          || typeof p.reportVersion !== "number" || !Number.isInteger(p.reportVersion) || p.reportVersion < 1 || p.reportVersion > 999999) return reply(400, { error: "INVALID_REQUEST" });
      const db = { rpc: (fn: string, args: Record<string, unknown>) => user.rpc(fn, args),
        select: (table: string, filters: Record<string, unknown>) => user.from(table).select("*").match(filters) };
      const compiled = await (services.compile ?? compileSavedReport)(db, p);
      const r = await services.service().rpc("fs_record_server_compilation", { p_actor: auth.data.user.id, p_company_id: p.companyId,
        p_report_id: p.reportId, p_report_version: p.reportVersion, p_document_hash: compiled.documentHash,
        p_dependencies_hash: compiled.dependenciesHash, p_canonical_document: compiled.canonicalDocument, p_evaluation: compiled.evaluation, p_source_snapshot: compiled.sourceSnapshot, p_compiler_sha256: STATEMENT_COMPILER_SHA256 });
      if (r.error) return reply(409, { error: r.error.message });
      return reply(200, r.data);
    } catch (error) { return reply(409, { error: error instanceof Error ? error.message : "SERVER_COMPILATION_FAILED" }); }
  };
}
