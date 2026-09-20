/**
 * FilingJurisdictionSetting — the globally neutral "Filing jurisdiction" control.
 *
 * An explicit, persisted choice (`companies.filing_jurisdiction` via the authorised RPC). It lists every ISO region alike —
 * names come from the runtime locale data — and never pre-selects, infers or defaults. Only an owner, partner or manager can
 * change it; the database also refuses a change while tax, compliance or filing services are in scope.
 */

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { ISO_REGION_CODES, jurisdictionName } from "@/lib/jurisdiction/registry";
import { TAX_PROFILE_COPY } from "@/lib/jurisdiction/taxProfile";
import { setFilingJurisdiction, WorkspaceSetupError } from "@/lib/workspace/workspaceSetupClient";

export default function FilingJurisdictionSetting({ companyId, jurisdiction, canChange }: { companyId: string; jurisdiction: string | null; canChange: boolean }) {
  const { refreshUpload } = useWorkspace();
  const [choice, setChoice] = useState<string>(jurisdiction ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(() => [...ISO_REGION_CODES].map((c) => ({ code: c, name: jurisdictionName(c) })).sort((a, b) => a.name.localeCompare(b.name)), []);

  const save = async () => {
    if (saving || !choice || choice === jurisdiction) return;
    setSaving(true);
    setError(null);
    try {
      await setFilingJurisdiction(supabase, companyId, choice);
      refreshUpload();
    } catch (e) {
      setError(e instanceof WorkspaceSetupError ? e.message : "The filing jurisdiction could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2" data-testid="filing-jurisdiction-setting">
      <label className="text-xs font-medium text-foreground" htmlFor="filing-jurisdiction">
        {TAX_PROFILE_COPY.jurisdictionLabel}
        <span className="ml-1 font-normal text-muted-foreground">— needed for tax, compliance and filing services</span>
      </label>
      {jurisdiction && <p className="text-xs text-muted-foreground" data-testid="filing-jurisdiction-current">Selected: {jurisdictionName(jurisdiction)}</p>}
      {!jurisdiction && <p className="text-xs text-muted-foreground" data-testid="filing-jurisdiction-current">Not selected</p>}
      {canChange ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select value={choice} onValueChange={setChoice} disabled={saving}>
            <SelectTrigger id="filing-jurisdiction" aria-label={TAX_PROFILE_COPY.jurisdictionLabel} className="w-full sm:w-72">
              <SelectValue placeholder="Select a jurisdiction" />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {options.map((o) => (
                <SelectItem key={o.code} value={o.code}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="button" size="sm" variant="outline" onClick={save} disabled={saving || !choice || choice === jurisdiction} data-testid="filing-jurisdiction-save">
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Only an owner, partner or manager can select the filing jurisdiction.</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
