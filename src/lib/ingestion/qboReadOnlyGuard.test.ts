import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { classifyQboRequest, createGuardedQboFetch, QBO_TOKEN_URL, qboAuthorizeUrl, QboGuardRefusal, qboReportUrl } from "../../../supabase/functions/_shared/qboReadOnlyGuard";

const REPORT = "https://quickbooks.api.intuit.com/v3/company/9341458604136919/reports/TrialBalance";
const SANDBOX = "https://sandbox-quickbooks.api.intuit.com/v3/company/9341458604136919/reports/TrialBalance";
const TOKEN = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

describe("read-only guard: what is allowed", () => {
  it.each<[string, string, string, string, string | null]>([
    ["production report", "GET", REPORT, "report", "production"],
    ["sandbox report", "GET", SANDBOX, "report", "sandbox"],
    ["report with the allowed query", "GET", `${REPORT}?start_date=2026-01-01&end_date=2026-12-31&accounting_method=Accrual&minorversion=75`, "report", "production"],
    ["token exchange / refresh", "POST", TOKEN, "token", null],
  ])("%s", (_l, method, url, kind, environment) => {
    expect(classifyQboRequest({ method, url })).toEqual({ ok: true, kind, environment });
  });
});

describe("read-only guard: everything else is refused", () => {
  it.each<[string, string, string]>([
    ["a write method on the report", "POST", REPORT],
    ["PUT", "PUT", REPORT],
    ["DELETE", "DELETE", REPORT],
    ["PATCH", "PATCH", REPORT],
    ["lower-case get (the guard is exact)", "get", REPORT],
    ["another report", "GET", REPORT.replace("TrialBalance", "ProfitAndLoss")],
    ["the French variant (no sample recorded yet)", "GET", REPORT.replace("TrialBalance", "TrialBalanceFR")],
    ["the query endpoint", "GET", "https://quickbooks.api.intuit.com/v3/company/9341458604136919/query?query=select%20*%20from%20Account"],
    ["an entity endpoint", "GET", "https://quickbooks.api.intuit.com/v3/company/9341458604136919/account"],
    ["an entity create", "POST", "https://quickbooks.api.intuit.com/v3/company/9341458604136919/journalentry"],
    ["the batch endpoint", "POST", "https://quickbooks.api.intuit.com/v3/company/9341458604136919/batch"],
    ["a company id that is not digits", "GET", "https://quickbooks.api.intuit.com/v3/company/abc/reports/TrialBalance"],
    ["a path under the report", "GET", `${REPORT}/extra`],
    ["a trailing slash", "GET", `${REPORT}/`],
    ["a doubled slash", "GET", "https://quickbooks.api.intuit.com//v3/company/1/reports/TrialBalance"],
    ["an encoded segment", "GET", "https://quickbooks.api.intuit.com/v3/company/1/reports/Trial%42alance"],
    ["a dot segment out of the report", "GET", "https://quickbooks.api.intuit.com/v3/company/1/reports/../account"],
    ["plain http", "GET", REPORT.replace("https:", "http:")],
    ["a port", "GET", REPORT.replace(".com/", ".com:8443/")],
    ["credentials in the address", "GET", REPORT.replace("https://", "https://user:pw@")],
    ["a fragment", "GET", `${REPORT}#x`],
    ["a look-alike host (suffix)", "GET", REPORT.replace("intuit.com", "intuit.com.evil.example")],
    ["a look-alike host (userinfo trick)", "GET", "https://evil.example@quickbooks.api.intuit.com.evil.example/v3/company/1/reports/TrialBalance"],
    ["another Intuit host", "GET", "https://developer.api.intuit.com/v2/oauth2/tokens/revoke"],
    ["an unknown query key", "GET", `${REPORT}?query=x`],
    ["a repeated query key", "GET", `${REPORT}?start_date=2026-01-01&start_date=2026-02-01`],
    ["a malformed date", "GET", `${REPORT}?start_date=2026-1-1`],
    ["a date macro (explicit dates only)", "GET", `${REPORT}?date_macro=Today`],
    ["an unknown accounting method", "GET", `${REPORT}?accounting_method=Other`],
    ["the token endpoint with GET", "GET", TOKEN],
    ["the token endpoint with a query", "POST", `${TOKEN}?x=1`],
    ["another token path", "POST", "https://oauth.platform.intuit.com/oauth2/v1/tokens/revoke"],
    ["not a URL", "GET", "not a url"],
    ["an empty address", "GET", ""],
  ])("%s", (_l, method, url) => {
    const v = classifyQboRequest({ method, url });
    expect(v.ok).toBe(false);
  });
});

describe("guarded fetch", () => {
  it("passes an allowed request through and never follows a redirect", async () => {
    const f = vi.fn(async () => new Response("{}"));
    const g = createGuardedQboFetch(f);
    await g({ method: "GET", url: REPORT, headers: { Accept: "application/json" } });
    expect(f).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledWith(REPORT, { method: "GET", headers: { Accept: "application/json" }, body: undefined, redirect: "error" });
  });

  it("refuses before any network call, with the stated reason", async () => {
    const f = vi.fn(async () => new Response("{}"));
    const g = createGuardedQboFetch(f);
    await expect(g({ method: "DELETE", url: REPORT })).rejects.toBeInstanceOf(QboGuardRefusal);
    await expect(g({ method: "GET", url: REPORT.replace("TrialBalance", "Account") })).rejects.toThrow(/not allowed/);
    await expect(g({ method: "GET", url: REPORT, body: "x" })).rejects.toThrow(/no body/);
    expect(f).not.toHaveBeenCalled();
  });

  it("allows the token call with a form body", async () => {
    const f = vi.fn(async () => new Response("{}"));
    await createGuardedQboFetch(f)({ method: "POST", url: TOKEN, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token&refresh_token=x" });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("the addresses the connector builds", () => {
  const CLIENT = "ABxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const STATE = "a".repeat(64);
  it("builds the authorisation address with the Accounting scope only and the state", () => {
    const u = new URL(qboAuthorizeUrl({ clientId: CLIENT, redirectUri: "https://app.example.test/functions/v1/qbo-oauth-callback", state: STATE }));
    expect(u.origin + u.pathname).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: CLIENT, response_type: "code", scope: "com.intuit.quickbooks.accounting", redirect_uri: "https://app.example.test/functions/v1/qbo-oauth-callback", state: STATE });
  });
  it("refuses a malformed client id, state or redirect address", () => {
    const ok = { clientId: CLIENT, redirectUri: "https://app.example.test/cb", state: STATE };
    expect(() => qboAuthorizeUrl({ ...ok, clientId: "bad id" })).toThrow(QboGuardRefusal);
    expect(() => qboAuthorizeUrl({ ...ok, state: "short" })).toThrow(QboGuardRefusal);
    expect(() => qboAuthorizeUrl({ ...ok, redirectUri: "http://app.example.test/cb" })).toThrow(QboGuardRefusal);
    expect(() => qboAuthorizeUrl({ ...ok, redirectUri: "https://app.example.test/cb?x=1" })).toThrow(QboGuardRefusal);
  });
  it("builds a report address that the guard itself allows, with both dates", () => {
    const url = qboReportUrl({ environment: "sandbox", realmId: "9341458607761798", startDate: "2026-01-01", endDate: "2026-10-31", accountingMethod: "Accrual", minorVersion: 75 });
    expect(url).toBe("https://sandbox-quickbooks.api.intuit.com/v3/company/9341458607761798/reports/TrialBalance?start_date=2026-01-01&end_date=2026-10-31&accounting_method=Accrual&minorversion=75");
    expect(classifyQboRequest({ method: "GET", url })).toEqual({ ok: true, kind: "report", environment: "sandbox" });
    expect(qboReportUrl({ environment: "production", realmId: "1", startDate: "2026-01-01", endDate: "2026-01-31" })).toMatch(/^https:\/\/quickbooks\.api\.intuit\.com\/v3\/company\/1\/reports\/TrialBalance\?start_date=/);
  });
  it("refuses to build a report address the guard would refuse", () => {
    const base = { environment: "sandbox" as const, realmId: "123", startDate: "2026-01-01", endDate: "2026-10-31" };
    expect(() => qboReportUrl({ ...base, realmId: "12ab" })).toThrow(QboGuardRefusal);
    expect(() => qboReportUrl({ ...base, startDate: "2026-1-1" })).toThrow(QboGuardRefusal);
    expect(() => qboReportUrl({ ...base, minorVersion: 1234 })).toThrow(QboGuardRefusal);
  });
  it("the token address is the one the guard allows for a POST and nothing else", () => {
    expect(classifyQboRequest({ method: "POST", url: QBO_TOKEN_URL })).toEqual({ ok: true, kind: "token", environment: null });
    expect(classifyQboRequest({ method: "GET", url: QBO_TOKEN_URL }).ok).toBe(false);
  });
});

describe("no other code may name an Intuit host", () => {
  const ROOT = path.resolve(__dirname, "../../..");
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

  it("only the guard (and tests) contain an intuit.com address in Edge Function code", () => {
    const offenders = walk(path.join(ROOT, "supabase/functions"))
      .filter((f) => /\.(ts|mjs|js)$/.test(f) && !/\.test\./.test(f))
      .filter((f) => /intuit\.com/i.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"));
    expect(offenders).toEqual(["supabase/functions/_shared/qboReadOnlyGuard.ts"]);
  });
});
