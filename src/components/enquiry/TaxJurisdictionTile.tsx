// The public "Tax and jurisdictional compliance" tile.
//
// Global neutrality: the tile face names NO country, claims NO capability and carries the state "Jurisdiction required". A
// jurisdiction appears only after the person explicitly selects one inside the dialog (or confirms one their own company
// setting already stores). Country names are composed at runtime from ISO codes, so no jurisdiction is named in this source.
//
//   private-preview jurisdiction → "<Country> expert assessment — private preview", locked / request-access, with a plain
//                                  disclosure that access depends on professional assessment and product readiness;
//   every other jurisdiction     → availability is assessed by jurisdiction: "Ask a jurisdiction specialist →" — never a dead end.
//
// Both routes submit through the one canonical form and backend. This component carries no tax rules, rates, forms or filing claims.

import { useEffect, useMemo, useState } from "react";
import { Globe2, Lock } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useStoredFilingJurisdiction } from "@/hooks/useStoredFilingJurisdiction";
import { jurisdictionName } from "@/lib/jurisdiction/registry";
import { TAX_TILE_COPY } from "@/lib/serviceEnquiry/copy";
import { countryOptions, pathwayPresentation, resolveTaxPathway } from "@/lib/serviceEnquiry/jurisdictionPathways";
import { ExpertTileFrame } from "./ExpertTileFrame";
import { SelectField } from "./EnquiryFields";
import { ServiceEnquiryForm } from "./ServiceEnquiryForm";

function TaxDialogBody() {
  const stored = useStoredFilingJurisdiction();
  const [country, setCountry] = useState("");
  const [touched, setTouched] = useState(false);
  const options = useMemo(() => countryOptions().map((c) => ({ value: c.code, label: c.name })), []);

  // A stored company setting pre-selects the control once it has loaded — visibly, and only until the person chooses.
  useEffect(() => {
    if (!touched && stored.code) setCountry(stored.code);
  }, [stored.code, touched]);

  const pathway = resolveTaxPathway(country);
  const presentation = pathway ? pathwayPresentation(pathway) : null;
  const prefilled = pathway !== null && stored.code === pathway.code;
  const name = pathway ? jurisdictionName(pathway.code) : "";

  return (
    <div className="space-y-5">
      <SelectField
        prefix="tax-jurisdiction"
        field="jurisdiction"
        label={TAX_TILE_COPY.selectLabel}
        value={country}
        onChange={(v) => {
          setTouched(true);
          setCountry(v);
        }}
        options={options}
        placeholder={TAX_TILE_COPY.selectPlaceholder}
        hint={prefilled ? TAX_TILE_COPY.companyPrefillNote : undefined}
        autoComplete="off"
      />

      <div aria-live="polite">
        {pathway && presentation && (
          <>
            <section className="mb-5 rounded-md border border-border bg-muted/40 p-4" data-testid="tax-pathway" data-pathway={pathway.kind}>
              <h3 className="text-sm font-semibold text-foreground">{presentation.heading}</h3>
              {presentation.stateLabel && (
                <p className="mt-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400" data-testid="tax-pathway-state">
                  <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                  {presentation.stateLabel}
                </p>
              )}
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{presentation.disclosure}</p>
            </section>
            <ServiceEnquiryForm
              key={pathway.code}
              formKey={`tax-${pathway.code}`}
              variant="tax"
              serviceCode={pathway.serviceCode}
              sourceContext="workflow_tax"
              jurisdiction={{ code: pathway.code, name, source: prefilled ? "company_setting_confirmed" : "user_selected" }}
              defaultSubject={`${pathway.kind === "PRIVATE_PREVIEW" ? "Tax assessment request" : "Tax enquiry"} — ${name}`}
              submitLabel={presentation.actionLabel}
              contextSummary={
                <dl className="grid gap-1 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">Service</dt>
                    <dd>{TAX_TILE_COPY.title}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">{TAX_TILE_COPY.selectLabel}</dt>
                    <dd>{name}</dd>
                  </div>
                </dl>
              }
            />
          </>
        )}
      </div>
    </div>
  );
}

export function TaxJurisdictionTile({ number }: { number: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ExpertTileFrame
        testId="tax-tile"
        number={number}
        stateLabel={TAX_TILE_COPY.state}
        stateIcon={<Globe2 className="h-3.5 w-3.5 text-amber-500" strokeWidth={2} aria-hidden="true" />}
        stateClassName="text-amber-700 dark:text-amber-400"
        title={TAX_TILE_COPY.title}
        description={TAX_TILE_COPY.description}
        producesLabel={TAX_TILE_COPY.producesLabel}
        produces={TAX_TILE_COPY.produces}
        actionLabel={TAX_TILE_COPY.action}
        actionAriaLabel={`${TAX_TILE_COPY.action.replace(/\s*→\s*$/, "")}: ${TAX_TILE_COPY.title}`}
        onAction={() => setOpen(true)}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] w-[calc(100vw-1rem)] overflow-y-auto p-4 sm:max-w-2xl sm:p-6">
          <DialogHeader className="pr-8 text-left">
            <DialogTitle>{TAX_TILE_COPY.dialogTitle}</DialogTitle>
            <DialogDescription>{TAX_TILE_COPY.description}</DialogDescription>
          </DialogHeader>
          <TaxDialogBody />
        </DialogContent>
      </Dialog>
    </>
  );
}
