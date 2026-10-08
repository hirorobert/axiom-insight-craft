// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewTimeline } from "@/components/closeReview/ReviewTimeline";
import { axeViolations, click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import { buildTimeline, timelineClient, type TimelineClient, type TimelineEventRow } from "./timeline";

const row = (o: Partial<TimelineEventRow> & { id: string; seq: number }): TimelineEventRow =>
  ({ event_type: "comment", body: "x", revises_event_id: null, detail: {}, actor_user_id: "u1", created_at: "2026-10-08T10:00:00Z", ...o });

describe("buildTimeline", () => {
  it("a revision updates its comment's current text, marks it edited and keeps every earlier version; order is the server's", () => {
    const t = buildTimeline([
      row({ id: "c2", seq: 3, revises_event_id: "c1", event_type: "comment_revised", body: "v2" }),
      row({ id: "c1", seq: 1, body: "v1" }),
      row({ id: "e1", seq: 2, event_type: "finding_explained", body: null, actor_user_id: null }),
    ]);
    expect(t.map((i) => i.id)).toEqual(["c1", "e1"]);
    expect(t[0]).toMatchObject({ kind: "comment", text: "v2", edited: true, versions: [{ text: "v1" }, { text: "v2" }] });
    expect(t[1]).toMatchObject({ kind: "event", eventType: "finding_explained", author: null });
  });
  it("a revision of an unknown comment is never shown on its own", () => {
    expect(buildTimeline([row({ id: "r", seq: 1, event_type: "comment_revised", revises_event_id: "gone", body: "orphan" })])).toEqual([]);
  });
});

describe("timelineClient", () => {
  it("reads one subject ordered by sequence and writes only through the server function", async () => {
    const calls: unknown[] = [];
    const q = { select: (c: string) => { calls.push(["select", c]); return q; }, eq: (c: string, v: string) => { calls.push(["eq", c, v]); return q; },
      order: async (c: string) => { calls.push(["order", c]); return { data: [], error: null }; } };
    const rpc = vi.fn(async () => ({ data: { outcome: "recorded", eventId: "e" }, error: null }));
    const c = timelineClient({ from: () => q as never, rpc: rpc as never });
    await c.read("co", "finding", "F-1");
    expect(calls).toContainEqual(["eq", "subject_id", "F-1"]);
    expect(calls).toContainEqual(["order", "seq"]);
    await c.comment("co", "finding", "F-1", "hi", "req", null);
    expect(rpc).toHaveBeenCalledWith("close_review_comment", { p_company_id: "co", p_subject_kind: "finding", p_subject_id: "F-1", p_body: "hi", p_request_id: "req", p_revises: null });
  });
});

let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; document.body.innerHTML = ""; });
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
function fake(rows: TimelineEventRow[], outcome = "recorded"): TimelineClient & { comment: ReturnType<typeof vi.fn> } {
  return { read: vi.fn(async () => rows), comment: vi.fn(async () => ({ outcome, eventId: "n" })) } as never;
}
const byText = (re: RegExp) => [...document.querySelectorAll("button")].find((b) => re.test(b.textContent ?? "")) as HTMLButtonElement;

describe("ReviewTimeline", () => {
  it("read-only member: the history, no comment box, no Edit; no axe violations", async () => {
    m = mount(h(ReviewTimeline, { client: fake([row({ id: "c1", seq: 1, body: "Rent doubled" })]), companyId: "co", subjectKind: "finding", subjectId: "F-1", canComment: false, currentUserId: "u1" }));
    await flush();
    expect(document.body.textContent).toContain("Rent doubled");
    expect(document.querySelector("textarea")).toBeNull();
    expect(byText(/^Edit$/)).toBeUndefined();
    expect(document.body.textContent).toContain("Read only");
    expect(await axeViolations(m.container)).toEqual([]);
  });
  it("a comment is sent once per request id: a retry of the same text reuses it; success reloads the history", async () => {
    const c = fake([]);
    c.comment.mockResolvedValueOnce({ outcome: "forbidden" as never }).mockResolvedValueOnce({ outcome: "recorded", eventId: "n" });
    let n = 0;
    m = mount(h(ReviewTimeline, { client: c, companyId: "co", subjectKind: "finding", subjectId: "F-1", canComment: true, currentUserId: "u1", newRequestId: () => `req-${++n}` }));
    await flush();
    typeInto(document.querySelector("textarea")!, "Check the lease");
    click(byText(/Add comment/)); await flush();
    expect(document.body.textContent).toContain("You can read this history but not add to it");
    click(byText(/Add comment/)); await flush();
    expect(c.comment.mock.calls.map((x) => x[4])).toEqual(["req-1", "req-1"]);
    expect(document.body.textContent).toContain("Comment recorded.");
    expect(c.read).toHaveBeenCalledTimes(2);
  });
  it("only the author sees Edit; an edit is sent as a revision of that comment", async () => {
    const c = fake([row({ id: "c1", seq: 1, body: "Mine" }), row({ id: "c2", seq: 2, body: "Theirs", actor_user_id: "u2" })]);
    m = mount(h(ReviewTimeline, { client: c, companyId: "co", subjectKind: "finding", subjectId: "F-1", canComment: true, currentUserId: "u1", newRequestId: () => "req-e" }));
    await flush();
    expect([...document.querySelectorAll("button")].filter((b) => b.textContent === "Edit")).toHaveLength(1);
    click(byText(/^Edit$/));
    typeInto(document.querySelector("textarea")!, "Mine, corrected");
    click(byText(/Save edit/)); await flush();
    expect(c.comment).toHaveBeenCalledWith("co", "finding", "F-1", "Mine, corrected", "req-e", "c1");
    expect(document.body.textContent).toContain("the earlier text stays in the history");
  });
});
