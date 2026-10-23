import { compileSavedReport } from "../_shared/statementCompiler.generated.mjs";
const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers });
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
      const text = await request.text(); if (text.length > 2048) return reply(400, { error: "INVALID_REQUEST" });
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
        p_dependencies_hash: compiled.dependenciesHash, p_canonical_document: compiled.canonicalDocument, p_evaluation: compiled.evaluation });
      if (r.error) return reply(409, { error: r.error.message });
      return reply(200, r.data);
    } catch (error) { return reply(409, { error: error instanceof Error ? error.message : "SERVER_COMPILATION_FAILED" }); }
  };
}
