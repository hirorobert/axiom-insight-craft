// The durable receipt shown after a successful submission. It states only what is true: the reference, when the request was
// recorded, and the honest state of the email acknowledgement (sent / pending / unavailable) — never a claim that an email was
// sent when it was not, and never any suggestion that an engagement has been accepted.

import { useEffect, useRef } from "react";
import { CheckCircle2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { EnquiryReceipt } from "@/lib/serviceEnquiry/contract";
import { ACKNOWLEDGEMENT_COPY, ENQUIRY_FORM_COPY } from "@/lib/serviceEnquiry/copy";

function formatReceiptTime(iso: string, locale?: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

interface Props {
  receipt: EnquiryReceipt;
  onAnother: () => void;
}

export function EnquiryReceiptView({ receipt, onAnother }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  return (
    <section aria-labelledby="enquiry-receipt-heading" className="space-y-5 rounded-lg border border-border bg-card p-5 sm:p-6" data-testid="enquiry-receipt">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden="true" />
        <h2 id="enquiry-receipt-heading" ref={heading} tabIndex={-1} className="text-lg font-semibold text-foreground focus:outline-none">
          {ENQUIRY_FORM_COPY.receiptHeading}
        </h2>
      </div>

      <dl className="grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{ENQUIRY_FORM_COPY.receiptReference}</dt>
          <dd className="mt-1 select-all break-all font-mono text-base font-semibold text-foreground" data-testid="enquiry-reference">
            {receipt.reference}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{ENQUIRY_FORM_COPY.receiptSubmitted}</dt>
          <dd className="mt-1 text-sm text-foreground">
            <time dateTime={receipt.submitted_at}>{formatReceiptTime(receipt.submitted_at)}</time>
          </dd>
        </div>
      </dl>

      <div className="flex items-start gap-2 rounded-md bg-muted/50 p-3 text-sm text-foreground" data-testid="enquiry-acknowledgement" data-state={receipt.acknowledgement}>
        <Mail className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p>{ACKNOWLEDGEMENT_COPY[receipt.acknowledgement]}</p>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-foreground">{ENQUIRY_FORM_COPY.receiptNext}</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{ENQUIRY_FORM_COPY.receiptNextBody}</p>
      </div>

      <Button type="button" variant="outline" onClick={onAnother} className="min-h-11 w-full sm:w-auto">
        {ENQUIRY_FORM_COPY.another}
      </Button>
    </section>
  );
}
