// The staff queue's data layer: URL-preserved filters (a hand-edited URL can never widen a query), RPC argument mapping, error
// classification, and strict parsing of RPC responses.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
import {
  DEFAULT_QUEUE_FILTERS,
  ENQUIRY_STATUSES,
  PAGE_SIZE,
  QueueError,
  SERVICE_LABELS,
  STATUS_LABELS,
  classifyRpcError,
  parseQueueFilters,
  toRpcArgs,
  toSearchParams,
  type QueueFilters,
} from "./staffQueue";
import { SERVICE_CODES } from "./contract";

const params = (q: string) => new URLSearchParams(q);
const UUID = "0b2f3c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";

describe("queue filters live in the URL", () => {
  it("defaults produce an empty query string and parse back to the defaults", () => {
    expect(toSearchParams(DEFAULT_QUEUE_FILTERS).toString()).toBe("");
    expect(parseQueueFilters(params(""))).toEqual(DEFAULT_QUEUE_FILTERS);
  });

  it("round-trips a fully specified view (status, service, jurisdiction, dates, search, page and the open enquiry)", () => {
    const view: QueueFilters = { status: ["triage", "scoping"], service: ["donor_reporting", "tax_general"], country: "KE", from: "2026-09-01", to: "2026-09-21", q: "acme ltd", page: 3, id: UUID };
    const url = toSearchParams(view).toString();
    expect(parseQueueFilters(params(url))).toEqual(view);
  });

  it("a hand-edited URL is sanitised: unknown statuses/services/countries, bad dates, junk pages and non-UUID ids are dropped", () => {
    const f = parseQueueFilters(params("status=triage,bogus,triage&service=general,evil&country=xx&from=yesterday&to=2026-13-99x&page=-4&id=not-a-uuid&q=" + "x".repeat(500)));
    expect(f.status).toEqual(["triage"]);
    expect(f.service).toEqual(["general"]);
    expect(f.country).toBe("");
    expect(f.from).toBe("");
    expect(f.to).toBe("");
    expect(f.page).toBe(1);
    expect(f.id).toBeNull();
    expect(f.q).toHaveLength(200);
    expect(parseQueueFilters(params("country=ke")).country).toBe("KE");
    expect(parseQueueFilters(params("page=abc")).page).toBe(1);
  });

  it("SQL-ish or script input in the search box is carried as plain text and never interpreted client-side", () => {
    const f = parseQueueFilters(params("q=" + encodeURIComponent("'; DROP TABLE service_enquiries; --")));
    expect(f.q).toBe("'; DROP TABLE service_enquiries; --");
    expect(toRpcArgs(f).p_search).toBe("'; DROP TABLE service_enquiries; --");
  });
});

describe("toRpcArgs", () => {
  it("omits unset filters and pages by PAGE_SIZE", () => {
    expect(toRpcArgs(DEFAULT_QUEUE_FILTERS)).toEqual({ p_limit: PAGE_SIZE, p_offset: 0 });
    expect(toRpcArgs({ ...DEFAULT_QUEUE_FILTERS, page: 3 })).toEqual({ p_limit: PAGE_SIZE, p_offset: 2 * PAGE_SIZE });
  });

  it("the date range is inclusive of BOTH chosen days (the end is sent as the start of the following day)", () => {
    const a = toRpcArgs({ ...DEFAULT_QUEUE_FILTERS, from: "2026-09-01", to: "2026-09-30" });
    expect(a.p_from).toBe("2026-09-01T00:00:00.000Z");
    expect(a.p_to).toBe("2026-10-01T00:00:00.000Z");
    expect(toRpcArgs({ ...DEFAULT_QUEUE_FILTERS, to: "2026-12-31" }).p_to).toBe("2027-01-01T00:00:00.000Z");
  });

  it("passes status, service, jurisdiction and trimmed search through", () => {
    expect(toRpcArgs({ ...DEFAULT_QUEUE_FILTERS, status: ["triage"], service: ["general"], country: "KE", q: "  ref  " })).toMatchObject({ p_status: ["triage"], p_service: ["general"], p_country: "KE", p_search: "ref" });
  });
});

describe("classifyRpcError", () => {
  it("maps database error codes to what the screen should do", () => {
    expect(classifyRpcError("42501")).toBe("forbidden");
    expect(classifyRpcError("P0002")).toBe("not_found");
    expect(classifyRpcError("40001")).toBe("stale");
    expect(classifyRpcError("23514")).toBe("invalid_transition");
    expect(classifyRpcError("22023")).toBe("invalid");
    expect(classifyRpcError("XX000")).toBe("unavailable");
    expect(classifyRpcError(undefined)).toBe("unavailable");
    expect(new QueueError("forbidden").kind).toBe("forbidden");
  });
});

describe("labels cover every status and service (a missing label would be a typecheck error)", () => {
  it("has a human label for all ten statuses and all five services", () => {
    expect(ENQUIRY_STATUSES).toHaveLength(10);
    for (const s of ENQUIRY_STATUSES) expect(STATUS_LABELS[s]).toMatch(/\w/);
    for (const s of SERVICE_CODES) expect(SERVICE_LABELS[s]).toMatch(/\w/);
  });
});
