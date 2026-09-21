// Workflow position 03 — "Report to a donor or funder". This is an EXPERT-LED intake, not a self-serve workflow: the tile opens
// the canonical enquiry form with the donor triage fields and submits service code `donor_reporting`. It asks only what initial
// triage needs and never infers donor rules, accounting basis, templates, eligibility or approval requirements, and it does not
// promise automatic report production.

import { useState } from "react";
import { UserCheck } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DONOR_TILE_COPY } from "@/lib/serviceEnquiry/copy";
import { ExpertTileFrame } from "./ExpertTileFrame";
import { ServiceEnquiryForm } from "./ServiceEnquiryForm";

export function DonorExpertTile() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ExpertTileFrame
        testId="donor-tile"
        number={DONOR_TILE_COPY.number}
        stateLabel={DONOR_TILE_COPY.state}
        stateIcon={<UserCheck className="h-3.5 w-3.5 text-sky-500" strokeWidth={2} aria-hidden="true" />}
        stateClassName="text-sky-700 dark:text-sky-400"
        title={DONOR_TILE_COPY.title}
        description={DONOR_TILE_COPY.description}
        producesLabel={DONOR_TILE_COPY.producesLabel}
        produces={DONOR_TILE_COPY.produces}
        actionLabel={DONOR_TILE_COPY.action}
        actionAriaLabel={`${DONOR_TILE_COPY.action.replace(/\s*→\s*$/, "")}: ${DONOR_TILE_COPY.title}`}
        onAction={() => setOpen(true)}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] w-[calc(100vw-1rem)] overflow-y-auto p-4 sm:max-w-2xl sm:p-6">
          <DialogHeader className="pr-8 text-left">
            <DialogTitle>{DONOR_TILE_COPY.dialogTitle}</DialogTitle>
            <DialogDescription>{DONOR_TILE_COPY.dialogIntro}</DialogDescription>
          </DialogHeader>
          <ServiceEnquiryForm
            formKey="donor"
            variant="donor"
            serviceCode="donor_reporting"
            sourceContext="workflow_donor"
            defaultSubject={DONOR_TILE_COPY.title}
            contextSummary={
              <p>
                <span className="font-medium">Service:</span> {DONOR_TILE_COPY.state} donor and funder reporting
              </p>
            }
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
