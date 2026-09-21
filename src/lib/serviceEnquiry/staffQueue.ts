// Data layer for the platform-staff enquiry queue. Every read and write goes through the staff_* database functions, which
// verify ACTIVE platform staff themselves; nothing here is a security boundary — a non-staff caller simply gets 42501.
// RPC responses are parsed with zod (never cast), and the queue's filters live in the URL so a view can be shared and survives
// a refresh.

import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { SERVICE_CODES, isIsoCountryCode } from "./contract";

export const ENQUIRY_STATUSES = ["submitted", "triage", "awaiting_client", "scoping", "proposal_sent", "accepted", "declined", "spam", "withdrawn", "closed"] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

export const STATUS_LABELS: Readonly<Record<EnquiryStatus, string>> = {
  submitted: "Submitted",
  triage: "In triage",
  awaiting_client: "Awaiting client",
  scoping: "Scoping",
  proposal_sent: "Proposal sent",
  accepted: "Accepted",
  declined: "Declined",
  spam: "Spam",
  withdrawn: "Withdrawn",
  closed: "Closed",
};

export const SERVICE_LABELS: Readonly<Record<(typeof SERVICE_CODES)[number], string>> = {
  general: "General enquiry",
  support: "Support",
  donor_reporting: "Donor reporting",
  tax_tanzania_preview: "Tax — private preview",
  tax_general: "Tax — general",
};

export const isEnquiryStatus = (v: string): v is EnquiryStatus => (ENQUIRY_STATUSES as readonly string[]).includes(v);
const isServiceCode = (v: string): v is (typeof SERVICE_CODES)[number] => (SERVICE_CODES as readonly string[]).includes(v);

// ── URL-preserved filters ─────────────────────────────────────────────────────────────────────────────────────────────

export const PAGE_SIZE = 25;

export interface QueueFilters {
  status: EnquiryStatus[];
  service: (typeof SERVICE_CODES)[number][];
  country: string;
  from: string;
  to: string;
  q: string;
  page: number;
  id: string | null;
}

export const DEFAULT_QUEUE_FILTERS: QueueFilters = { status: [], service: [], country: "", from: "", to: "", q: "", page: 1, id: null };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const csv = (v: string | null): string[] => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

/** Reads filters from the URL, discarding anything that is not a known value — a hand-edited URL can never widen a query. */
export function parseQueueFilters(params: URLSearchParams): QueueFilters {
  const country = (params.get("country") ?? "").toUpperCase();
  const page = Number.parseInt(params.get("page") ?? "1", 10);
  const id = params.get("id");
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  return {
    status: [...new Set(csv(params.get("status")).filter(isEnquiryStatus))],
    service: [...new Set(csv(params.get("service")).filter(isServiceCode))],
    country: isIsoCountryCode(country) ? country : "",
    from: DATE_RE.test(from) ? from : "",
    to: DATE_RE.test(to) ? to : "",
    q: (params.get("q") ?? "").slice(0, 200),
    page: Number.isFinite(page) && page >= 1 ? page : 1,
    id: id && UUID_RE.test(id) ? id.toLowerCase() : null,
  };
}

/** Serialises filters, omitting defaults so URLs stay short and stable. */
export function toSearchParams(f: QueueFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.status.length) p.set("status", f.status.join(","));
  if (f.service.length) p.set("service", f.service.join(","));
  if (f.country) p.set("country", f.country);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.page > 1) p.set("page", String(f.page));
  if (f.id) p.set("id", f.id);
  return p;
}

export interface QueueRpcArgs {
  p_status?: string[];
  p_service?: string[];
  p_country?: string;
  p_from?: string;
  p_to?: string;
  p_search?: string;
  p_limit: number;
  p_offset: number;
}

const nextDay = (ymd: string): string => {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
};

/** The date range is inclusive of both chosen days (to is sent as the start of the following day). */
export function toRpcArgs(f: QueueFilters): QueueRpcArgs {
  return {
    ...(f.status.length ? { p_status: f.status } : {}),
    ...(f.service.length ? { p_service: f.service } : {}),
    ...(f.country ? { p_country: f.country } : {}),
    ...(f.from ? { p_from: `${f.from}T00:00:00.000Z` } : {}),
    ...(f.to ? { p_to: nextDay(f.to) } : {}),
    ...(f.q.trim() ? { p_search: f.q.trim() } : {}),
    p_limit: PAGE_SIZE,
    p_offset: (f.page - 1) * PAGE_SIZE,
  };
}

// ── response schemas ──────────────────────────────────────────────────────────────────────────────────────────────────

const ackState = z.enum(["sent", "pending", "unavailable"]);

const queueRow = z.object({
  id: z.string().uuid(),
  public_reference: z.string(),
  requester_name: z.string(),
  requester_email: z.string(),
  organization: z.string().nullable(),
  country_code: z.string().nullable(),
  service_code: z.string(),
  source_context: z.string(),
  subject: z.string(),
  status: z.string(),
  assigned_to_user_id: z.string().uuid().nullable(),
  submitted_at: z.string(),
  acknowledgement: ackState,
  staff_notification: z.string().nullable(),
});
export type QueueRow = z.infer<typeof queueRow>;

const queueList = z.object({ total: z.number(), limit: z.number(), offset: z.number(), rows: z.array(queueRow) });
export type QueueList = z.infer<typeof queueList>;

const detailSchema = z.object({
  enquiry: z.object({
    id: z.string().uuid(),
    public_reference: z.string(),
    requester_name: z.string(),
    requester_email: z.string(),
    requester_is_account: z.boolean(),
    organization: z.string().nullable(),
    country_code: z.string().nullable(),
    service_code: z.string(),
    source_context: z.string(),
    subject: z.string(),
    message: z.string(),
    payload_schema_version: z.number(),
    payload: z.record(z.string()),
    status: z.string(),
    assigned_to_user_id: z.string().uuid().nullable(),
    submitted_at: z.string(),
    updated_at: z.string(),
  }),
  allowed_transitions: z.array(z.string()),
  events: z.array(
    z.object({
      id: z.string().uuid(),
      seq: z.number(),
      event_kind: z.enum(["submitted", "status_change", "assignment", "note"]),
      previous_status: z.string().nullable(),
      new_status: z.string(),
      actor_kind: z.enum(["requester", "system", "staff"]),
      actor_user_id: z.string().uuid().nullable(),
      actor_email: z.string().nullable(),
      assigned_to_user_id: z.string().uuid().nullable(),
      note: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
  notifications: z.array(z.object({ kind: z.string(), status: z.string(), attempt_count: z.number(), last_error_code: z.string().nullable(), sent_at: z.string().nullable() })),
});
export type EnquiryDetail = z.infer<typeof detailSchema>;

const staffSchema = z.array(z.object({ user_id: z.string().uuid(), staff_role: z.enum(["triage_agent", "manager"]), email: z.string().nullable() }));
export type StaffMember = z.infer<typeof staffSchema>[number];

// ── errors ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type QueueErrorKind = "forbidden" | "not_found" | "stale" | "invalid_transition" | "invalid" | "unavailable";

export class QueueError extends Error {
  constructor(readonly kind: QueueErrorKind) {
    super(kind);
    this.name = "QueueError";
  }
}

/** Maps a database error code to what the screen should do. Messages are never surfaced or logged. */
export function classifyRpcError(code: string | undefined): QueueErrorKind {
  switch (code) {
    case "42501":
      return "forbidden";
    case "P0002":
      return "not_found";
    case "40001":
      return "stale";
    case "23514":
      return "invalid_transition";
    case "22023":
      return "invalid";
    default:
      return "unavailable";
  }
}

function unwrap<T>(result: { data: unknown; error: { code?: string } | null }, schema: z.ZodType<T>): T {
  if (result.error) throw new QueueError(classifyRpcError(result.error.code));
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) throw new QueueError("unavailable");
  return parsed.data;
}

// ── calls ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function fetchStaffRole(): Promise<"triage_agent" | "manager" | null> {
  const { data, error } = await supabase.rpc("current_platform_staff_role");
  if (error) throw new QueueError(classifyRpcError(error.code));
  return data === "triage_agent" || data === "manager" ? data : null;
}

export const listEnquiries = async (filters: QueueFilters): Promise<QueueList> => unwrap(await supabase.rpc("staff_list_service_enquiries", toRpcArgs(filters)), queueList);
export const getEnquiry = async (id: string): Promise<EnquiryDetail> => unwrap(await supabase.rpc("staff_get_service_enquiry", { p_enquiry_id: id }), detailSchema);
export const listStaff = async (): Promise<StaffMember[]> => unwrap(await supabase.rpc("staff_list_platform_staff"), staffSchema);

const doneSchema = z.object({}).passthrough();
export const transitionEnquiry = async (id: string, to: EnquiryStatus, expected: string, note: string | null): Promise<void> => {
  unwrap(await supabase.rpc("staff_transition_service_enquiry", { p_enquiry_id: id, p_to_status: to, p_expected_status: expected, ...(note ? { p_note: note } : {}) }), doneSchema);
};
export const assignEnquiry = async (id: string, assignee: string | null, note: string | null): Promise<void> => {
  unwrap(await supabase.rpc("staff_assign_service_enquiry", { p_enquiry_id: id, p_assignee: assignee, ...(note ? { p_note: note } : {}) }), doneSchema);
};
export const addEnquiryNote = async (id: string, note: string): Promise<void> => {
  unwrap(await supabase.rpc("staff_add_service_enquiry_note", { p_enquiry_id: id, p_note: note }), doneSchema);
};

const dispatchSchema = z.object({ claimed: z.number(), sent: z.number(), retry: z.number(), failed: z.number(), blocked: z.number() });
export type DispatchTally = z.infer<typeof dispatchSchema>;

/** Staff-triggered retry of pending notifications (verified server-side: only ACTIVE platform staff are accepted). */
export async function retryPendingNotifications(): Promise<DispatchTally> {
  const { data, error } = await supabase.functions.invoke("dispatch-enquiry-notifications", { body: {} });
  if (error) throw new QueueError("unavailable");
  const parsed = dispatchSchema.safeParse(data);
  if (!parsed.success) throw new QueueError("unavailable");
  return parsed.data;
}
