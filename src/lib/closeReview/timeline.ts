/**
 * Close Review timeline (roadmap increment 8): the browser's model and client for one subject's append-only history.
 *
 * The server is the only writer (close_review_comment); this module reads close_review_events (RLS: workspace access
 * and the financial-statements rollout) and turns them into what a person reads: each comment shows its CURRENT text,
 * says it was edited, and keeps every earlier version; every other event (finding and adjustment lifecycle, added by
 * later increments) is one line. Nothing is ever removed from the history.
 */

export type SubjectKind = "finding" | "adjustment" | "report_version" | "upload";

export interface TimelineEventRow {
  id: string;
  seq: number;
  event_type: string;
  body: string | null;
  revises_event_id: string | null;
  detail: Record<string, unknown> | null;
  actor_user_id: string | null;
  created_at: string;
}

export type TimelineItem =
  | { kind: "comment"; id: string; author: string | null; at: string; text: string; edited: boolean; versions: { text: string; at: string }[] }
  | { kind: "event"; id: string; eventType: string; author: string | null; at: string; detail: Record<string, unknown> };

/** Ordered by the server's sequence. A revision whose original is not in the list is ignored (never shown alone). */
export function buildTimeline(rows: readonly TimelineEventRow[]): TimelineItem[] {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const comments = new Map<string, Extract<TimelineItem, { kind: "comment" }>>();
  const items: TimelineItem[] = [];
  for (const r of sorted) {
    if (r.event_type === "comment" && r.body !== null) {
      const c = { kind: "comment" as const, id: r.id, author: r.actor_user_id, at: r.created_at, text: r.body, edited: false, versions: [{ text: r.body, at: r.created_at }] };
      comments.set(r.id, c);
      items.push(c);
    } else if (r.event_type === "comment_revised" && r.body !== null && r.revises_event_id) {
      const c = comments.get(r.revises_event_id);
      if (c) { c.text = r.body; c.edited = true; c.versions.push({ text: r.body, at: r.created_at }); }
    } else {
      items.push({ kind: "event", id: r.id, eventType: r.event_type, author: r.actor_user_id, at: r.created_at, detail: r.detail ?? {} });
    }
  }
  return items;
}

export type CommentOutcome = "recorded" | "forbidden" | "feature_disabled" | "not_found" | "not_author" | "invalid_request" | "request_reused";
export const COMMENT_REFUSALS: Record<Exclude<CommentOutcome, "recorded">, string> = {
  forbidden: "You can read this history but not add to it (comments need Prepare or Review in this workspace).",
  feature_disabled: "Close Review is not enabled for this workspace. Nothing was recorded.",
  not_found: "That comment is no longer available to edit.",
  not_author: "Only the author can edit a comment.",
  invalid_request: "Write between 1 and 4,000 characters.",
  request_reused: "This was already sent with different text. Reload and try again.",
};

export interface TimelineClient {
  read(companyId: string, kind: SubjectKind, subjectId: string): Promise<TimelineEventRow[]>;
  comment(companyId: string, kind: SubjectKind, subjectId: string, body: string, requestId: string, revises?: string | null):
    Promise<{ outcome: CommentOutcome; eventId?: string }>;
}

type Q = { select(c: string): Q; eq(c: string, v: string): Q; order(c: string, o: { ascending: boolean }): PromiseLike<{ data: TimelineEventRow[] | null; error: { message: string } | null }> };
export interface TimelineDb {
  from(t: "close_review_events"): Q;
  rpc(name: "close_review_comment", args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export function timelineClient(db: TimelineDb): TimelineClient {
  return {
    read: async (companyId, kind, subjectId) => {
      const { data, error } = await db.from("close_review_events").select("id, seq, event_type, body, revises_event_id, detail, actor_user_id, created_at")
        .eq("company_id", companyId).eq("subject_kind", kind).eq("subject_id", subjectId).order("seq", { ascending: true });
      if (error) throw new Error("The history could not be read.");
      return data ?? [];
    },
    comment: async (companyId, kind, subjectId, body, requestId, revises = null) => {
      const { data, error } = await db.rpc("close_review_comment", { p_company_id: companyId, p_subject_kind: kind, p_subject_id: subjectId, p_body: body, p_request_id: requestId, p_revises: revises });
      if (error) throw new Error("The comment could not be sent. Nothing was recorded.");
      return data as { outcome: CommentOutcome; eventId?: string };
    },
  };
}
