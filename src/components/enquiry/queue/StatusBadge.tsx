// Enquiry status as icon + word (never colour alone), plus the notification state chip. Notification state is deliberately a
// separate control from status: an unsent email says nothing about where the enquiry stands.

import { Archive, CheckCircle2, Clock, FileSearch, Inbox, Mail, MailCheck, MailWarning, MailX, Search, Send, ShieldAlert, Undo2, XCircle, type LucideIcon } from "lucide-react";
import { isNotificationStatus, type NotificationStatus } from "@/lib/serviceEnquiry/contract";
import { STATUS_LABELS, isEnquiryStatus, notificationStatusLabel, type EnquiryStatus } from "@/lib/serviceEnquiry/staffQueue";

const STATUS_ICON: Readonly<Record<EnquiryStatus, LucideIcon>> = {
  submitted: Inbox,
  triage: Search,
  awaiting_client: Clock,
  scoping: FileSearch,
  proposal_sent: Send,
  accepted: CheckCircle2,
  declined: XCircle,
  spam: ShieldAlert,
  withdrawn: Undo2,
  closed: Archive,
};

export function StatusBadge({ status }: { status: string }) {
  const known = isEnquiryStatus(status);
  const Icon = known ? STATUS_ICON[status] : Inbox;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-2.5 py-0.5 text-xs font-medium text-foreground" data-testid="status-badge" data-status={status}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {known ? STATUS_LABELS[status] : status}
    </span>
  );
}

// Icon + word, never colour alone. "Accepted" (the provider took the message) and "delivered" (a verified provider event)
// are different states with different icons and words; only accepted can occur today.
const NOTIFICATION_ICON: Readonly<Record<NotificationStatus, LucideIcon>> = {
  queued: Clock,
  processing: Clock,
  accepted: Mail,
  delivered: MailCheck,
  failed: MailX,
  bounced: MailWarning,
};

export function NotificationChip({ label, state }: { label: string; state: string | null }) {
  const Icon = state !== null && isNotificationStatus(state) ? NOTIFICATION_ICON[state] : MailWarning;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid="notification-chip" data-state={state ?? "none"}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {label}: {notificationStatusLabel(state)}
    </span>
  );
}
