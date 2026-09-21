// PRODUCT behaviour of the enquiry system, pinned from the source (this project has no component-rendering harness, so — like
// its other UI contracts — these read the real files): the six entry points, the expert-led donor tile, the jurisdiction-neutral
// tax tile, no uploads, no Phase 2 entities, the accessibility and mobile invariants, and the queue's permission handling.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DOCUMENT_REVIEW_ENABLED, PUBLIC_PRODUCT_OUTCOMES } from "@/lib/product/outcomes";
import { ENTRY_POINTS, CONTACT_ROUTE, contactHref, sourceFromSearch } from "./entryPoints";
import { DONOR_TILE_COPY, ENQUIRY_NOTICES, HELP_SUPPORT_COPY, TAX_TILE_COPY } from "./copy";
import { SOURCE_CONTEXTS } from "./contract";

const ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(ROOT, "src");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");

/** Every non-test source file that belongs to this feature. */
const FEATURE_FILES = [
  ...walk(path.join(SRC, "components/enquiry")),
  ...walk(path.join(SRC, "lib/serviceEnquiry")),
  ...walk(path.join(SRC, "pages/admin")),
  path.join(SRC, "pages/Contact.tsx"),
  path.join(SRC, "hooks/useStoredFilingJurisdiction.ts"),
  ...["_shared/serviceEnquiryContract.ts", "_shared/serviceEnquiryEmail.ts", "_shared/serviceEnquiryHandler.ts", "_shared/serviceEnquiryWiring.ts", "submit-service-enquiry/index.ts", "dispatch-enquiry-notifications/index.ts"].map((f) => path.join(ROOT, "supabase/functions", f)),
].map(rel);

describe("one canonical backend, six entry points", () => {
  it("registers exactly the six entry points, every one on a validated source context", () => {
    expect(ENTRY_POINTS.map((e) => e.id).sort()).toEqual(["contact_page", "footer", "header", "help_support", "workflow_donor", "workflow_tax"]);
    for (const e of ENTRY_POINTS) expect((SOURCE_CONTEXTS as readonly string[]).includes(e.sourceContext), e.id).toBe(true);
    expect(new Set(ENTRY_POINTS.map((e) => e.sourceContext)).size).toBe(6);
  });

  it("every route entry leads to the ONE canonical /contact route, carrying only a whitelisted source", () => {
    for (const e of ENTRY_POINTS.filter((x) => x.kind === "route")) expect(e.route?.startsWith(CONTACT_ROUTE), e.id).toBe(true);
    expect(contactHref("site_header")).toBe("/contact?from=site_header");
    expect(sourceFromSearch("site_footer")).toBe("site_footer");
    for (const hostile of [null, "", "workflow_tax", "workflow_donor", "https://evil.example.test", "<script>", "constructor"]) expect(sourceFromSearch(hostile), String(hostile)).toBe("contact_page");
  });

  it("the public header, footer and both help/support menus link to the canonical contact route", () => {
    expect(code("src/components/Header.tsx")).toMatch(/contactHref\("site_header"\)/);
    expect(code("src/components/Header.tsx")).toMatch(/contactHref\("help_support"\)/);
    expect(code("src/components/Footer.tsx")).toMatch(/contactHref\("site_footer"\)/);
    expect(code("src/pages/workspace/WorkspaceLayout.tsx")).toMatch(/contactHref\("help_support"\)/);
    expect(read("src/lib/serviceEnquiry/serviceEnquiryRoutes.tsx")).toMatch(/path="\/contact"[\s\S]*?<Contact \/>/);
  });

  it("the contact page, the donor tile and the tax tile ALL render the one ServiceEnquiryForm", () => {
    for (const f of ["src/pages/Contact.tsx", "src/components/enquiry/DonorExpertTile.tsx", "src/components/enquiry/TaxJurisdictionTile.tsx"]) expect(code(f), f).toMatch(/<ServiceEnquiryForm\b/);
    const users = walk(SRC).filter((f) => /<ServiceEnquiryForm\b/.test(fs.readFileSync(f, "utf8"))).map(rel).sort();
    expect(users).toEqual(["src/components/enquiry/DonorExpertTile.tsx", "src/components/enquiry/TaxJurisdictionTile.tsx", "src/pages/Contact.tsx"]);
  });

  it("only client.ts calls the submit function, and nothing in the browser reads or writes the canonical tables directly", () => {
    const invokers = walk(SRC).filter((f) => /submit-service-enquiry/.test(code(rel(f)))).map(rel);
    expect(invokers).toEqual(["src/lib/serviceEnquiry/client.ts"]);
    for (const f of walk(SRC)) {
      const c = code(rel(f));
      if (rel(f) === "src/integrations/supabase/types.ts") continue;
      expect(c, rel(f)).not.toMatch(/\.from\(\s*["'](service_enquir|platform_staff)/);
    }
  });

  it("the staff queue talks to the database only through the staff_* / current_platform_staff_role functions and the dispatch function", () => {
    const c = code("src/lib/serviceEnquiry/staffQueue.ts");
    const rpcs = [...c.matchAll(/supabase\.rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(rpcs).toEqual(["current_platform_staff_role", "staff_add_service_enquiry_note", "staff_assign_service_enquiry", "staff_get_service_enquiry", "staff_list_platform_staff", "staff_list_service_enquiries", "staff_transition_service_enquiry"]);
    expect(c).not.toMatch(/supabase\.from\(/);
  });
});

describe("donor / funder expert intake (position 03, expert-led)", () => {
  it("uses the specified wording exactly", () => {
    expect(DONOR_TILE_COPY.number).toBe("03");
    expect(DONOR_TILE_COPY.title).toBe("Report to a donor or funder");
    expect(DONOR_TILE_COPY.state).toBe("Expert-led");
    expect(DONOR_TILE_COPY.description).toBe("Request a controlled donor-reporting engagement for an award, grant or funded programme.");
    expect(DONOR_TILE_COPY.produces).toBe("Scope assessment and reporting plan");
    expect(DONOR_TILE_COPY.action).toBe("Request expert support →");
  });

  it("fills the numbered slot the withheld statement-review outcome leaves, so the public sequence reads 01–06 (renumber if statement review is ever released)", () => {
    expect(DOCUMENT_REVIEW_ENABLED).toBe(false);
    expect([...PUBLIC_PRODUCT_OUTCOMES.map((o) => o.number), DONOR_TILE_COPY.number].sort()).toEqual(["01", "02", "03", "04", "05", "06"]);
  });

  it("is rendered in the public outcome selector immediately before the tax tile, inside the existing PUBLIC_PRODUCT_OUTCOMES map", () => {
    const tour = code("src/components/ProductTour.tsx");
    expect(tour).toMatch(/PUBLIC_PRODUCT_OUTCOMES\.map/);
    expect(tour).toMatch(/outcome\.id === "tax-compliance" && SERVICE_ENQUIRY_SURFACES\.taxExperience \?[\s\S]*?\{SERVICE_ENQUIRY_SURFACES\.donorTile && <DonorExpertTile \/>\}\s*<TaxJurisdictionTile number=\{outcome\.number\} \/>/);
  });

  it("submits service code donor_reporting from the workflow_donor context, with only triage fields", () => {
    const tile = code("src/components/enquiry/DonorExpertTile.tsx");
    expect(tile).toMatch(/serviceCode="donor_reporting"/);
    expect(tile).toMatch(/sourceContext="workflow_donor"/);
    const form = read("src/components/enquiry/ServiceEnquiryForm.tsx");
    for (const field of ["report_type", "donor_name", "project_name", "reporting_period", "reporting_frequency", "currency", "deadline", "additional_context"]) expect(form, field).toContain(`payload.${field}`);
  });

  it("infers nothing and promises nothing: no donor rules, accounting basis, templates, eligibility, approvals or automatic report production", () => {
    const wording = [DONOR_TILE_COPY.title, DONOR_TILE_COPY.description, DONOR_TILE_COPY.produces, DONOR_TILE_COPY.dialogIntro].join(" ");
    expect(wording).not.toMatch(/automatic|instant|generate[sd]?\b|guarantee|compliant|approved|eligib|template|USAID|FCDO|Global Fund|IPSAS|IFRS/i);
    const tile = code("src/components/enquiry/DonorExpertTile.tsx");
    expect(tile).not.toMatch(/reportingFramework|accountingBasis|eligib|approval|template/i);
  });

  it("exposes none of the Phase 2 internal entity names anywhere in the feature", () => {
    const all = [...FEATURE_FILES.map((f) => code(f)), read("supabase/migrations/20260921100000_service_enquiry_intake.sql")].join("\n");
    expect(all).not.toMatch(/\b(donor_award|award_id|donor_pack|transaction_map|approval_chain|donor_report_version|DonorWorkbench|donorReporting[A-Z]\w+)\b/);
  });
});

describe("tax: globally neutral, jurisdiction-gated", () => {
  it("the public selector renders the neutral tile for the tax outcome and never its 'Workflow available' article", () => {
    const tour = code("src/components/ProductTour.tsx");
    expect(tour.indexOf('outcome.id === "tax-compliance"')).toBeGreaterThan(-1);
    expect(tour.indexOf('outcome.id === "tax-compliance"')).toBeLessThan(tour.indexOf("<article"));
    expect(tour).toMatch(/<TaxJurisdictionTile/);
  });

  it("the tile FACE reads only from TAX_TILE_COPY — no country, no capability claim — and carries the neutral state", () => {
    expect(TAX_TILE_COPY.state).toBe("Jurisdiction required");
    const src = code("src/components/enquiry/TaxJurisdictionTile.tsx");
    const face = /export function TaxJurisdictionTile[\s\S]*$/.exec(src)?.[0] ?? "";
    const frameProps = /<ExpertTileFrame[\s\S]*?onAction=\{[^}]*\}\s*\/>/.exec(face)?.[0] ?? "";
    expect(frameProps).toMatch(/TAX_TILE_COPY\.title/);
    expect(frameProps).toMatch(/TAX_TILE_COPY\.action/);
    expect(frameProps).not.toMatch(/jurisdictionName|resolveTaxPathway|pathwayPresentation|useStoredFilingJurisdiction|"[A-Z][a-z]{3,}"/);
  });

  it("a country is never defaulted: the selector starts empty and the stored-setting hook is consulted only inside the dialog", () => {
    const src = code("src/components/enquiry/TaxJurisdictionTile.tsx");
    expect(src).toMatch(/useState\(""\)/);
    const beforeDialogBody = src.slice(0, src.indexOf("export function TaxJurisdictionTile"));
    expect(beforeDialogBody).toMatch(/useStoredFilingJurisdiction\(\)/); // inside TaxDialogBody
    expect(src.slice(src.indexOf("export function TaxJurisdictionTile"))).not.toMatch(/useStoredFilingJurisdiction/);
    expect(code("src/components/ProductTour.tsx")).not.toMatch(/useStoredFilingJurisdiction|resolveTaxPathway/);
  });

  it("a stored company jurisdiction pre-fills VISIBLY and stays editable; it never claims confirmation unless the person keeps it", () => {
    const src = code("src/components/enquiry/TaxJurisdictionTile.tsx");
    expect(src).toMatch(/TAX_TILE_COPY\.companyPrefillNote/);
    expect(src).toMatch(/source: prefilled \? "company_setting_confirmed" : "user_selected"/);
    expect(code("src/hooks/useStoredFilingJurisdiction.ts")).toMatch(/codes\.size === 1/);
  });

  it("the private-preview and general routes submit tax_tanzania_preview / tax_general through the same form, from the workflow_tax context", () => {
    const src = code("src/components/enquiry/TaxJurisdictionTile.tsx");
    expect(src).toMatch(/serviceCode=\{pathway\.serviceCode\}/);
    expect(src).toMatch(/sourceContext="workflow_tax"/);
    expect(src).toMatch(/submitLabel=\{presentation\.actionLabel\}/);
    expect(src).toMatch(/data-pathway=\{pathway\.kind\}/);
  });

  it("no literal jurisdiction name appears in ANY feature source (names are composed at runtime from ISO codes)", () => {
    for (const f of FEATURE_FILES) expect(code(f), f).not.toMatch(/Tanzania|Tanzanian/);
  });

  it("the feature carries no tax engine, tax computation, statutory pack or filing logic", () => {
    for (const f of FEATURE_FILES) expect(code(f), f).not.toMatch(/kinga|tax_computations|jurisdiction-packs|packLoader|computeWearTear|EFDMS|\bTRA\b|hesabu/i);
  });
});

describe("no file uploads and no attachment endpoint", () => {
  it("the feature contains no file input, FormData, FileReader, storage access, multipart handling or attachment wording", () => {
    for (const f of FEATURE_FILES) {
      const c = code(f);
      expect(c, f).not.toMatch(/type=["']file["']|\bFormData\b|\bFileReader\b|\.upload\(|storage\.from|multipart|\battachment|\bBlob\b|<input[^>]*\baccept=/i);
    }
  });

  it("no additional Edge Function exists for uploads, and only the two intended enquiry functions were added", () => {
    const fns = fs.readdirSync(path.join(ROOT, "supabase/functions"));
    expect(fns.filter((f) => /enquir/.test(f)).sort()).toEqual(["dispatch-enquiry-notifications", "submit-service-enquiry"]);
    expect(fns.filter((f) => /upload|attach/.test(f))).toEqual([]);
  });

  it("the form states the sensitive-material rule and that it does not establish an engagement", () => {
    expect(ENQUIRY_NOTICES.sensitive).toBe("Do not submit passwords, credentials or highly sensitive source documents.");
    expect(ENQUIRY_NOTICES.noEngagement).toBe("This form does not establish an engagement.");
    expect(ENQUIRY_NOTICES.review).toBe("A CFOClose specialist will review your request.");
    const form = code("src/components/enquiry/ServiceEnquiryForm.tsx");
    expect(form).toMatch(/ENQUIRY_NOTICES\.sensitive/);
    expect(form).toMatch(/ENQUIRY_NOTICES\.noEngagement/);
    expect(form).toMatch(/ENQUIRY_NOTICES\.review/);
  });
});

describe("receipt, double submission and refresh", () => {
  it("the form starts from any stored receipt (a refresh shows the receipt, never a blank resubmittable form) and stores it on success", () => {
    const form = code("src/components/enquiry/ServiceEnquiryForm.tsx");
    expect(form).toMatch(/useState<EnquiryReceipt \| null>\(\(\) => loadReceipt\(formKey\)\)/);
    expect(form).toMatch(/saveReceipt\(formKey, outcome\.receipt\)/);
    expect(form).toMatch(/if \(receipt\) return <EnquiryReceiptView/);
  });

  it("a synchronous in-flight guard and a disabled submit button prevent double submission, on top of the server idempotency key", () => {
    const form = code("src/components/enquiry/ServiceEnquiryForm.tsx");
    expect(form).toMatch(/if \(inFlight\.current\) return;[\s\S]*?inFlight\.current = true;/);
    expect(form).toMatch(/finally \{\s*inFlight\.current = false;/);
    expect(form).toMatch(/disabled=\{submitting\}/);
    expect(form).toMatch(/aria-busy=\{submitting\}/);
    expect(form).toMatch(/resolveAttempt\(loadAttempt\(formKey\), fingerprint/);
  });

  it("the receipt shows the reference, the time and the HONEST acknowledgement state — and never claims engagement acceptance", () => {
    const view = code("src/components/enquiry/EnquiryReceiptView.tsx");
    expect(view).toMatch(/receipt\.reference/);
    expect(view).toMatch(/receipt\.submitted_at/);
    expect(view).toMatch(/ACKNOWLEDGEMENT_COPY\[receipt\.acknowledgement\]/);
    const copy = code("src/lib/serviceEnquiry/copy.ts");
    expect(copy).toMatch(/acknowledgement is not available right now/);
    expect(copy).toMatch(/acknowledgement is pending/);
    expect(copy).toMatch(/not acceptance of an engagement/);
  });
});

describe("accessibility and mobile", () => {
  const fields = code("src/components/enquiry/EnquiryFields.tsx");
  const form = code("src/components/enquiry/ServiceEnquiryForm.tsx");

  it("every field has a persistent visible label (never a placeholder), and errors are linked with aria-invalid / aria-describedby and carry an icon plus text", () => {
    expect(fields).toMatch(/<Label htmlFor=\{id\}/);
    expect(fields).toMatch(/"aria-invalid": Boolean\(error\)/);
    expect(fields).toMatch(/"aria-describedby": describedBy/);
    expect(fields).toMatch(/<AlertCircle[\s\S]*?aria-hidden="true"/);
    expect(fields).not.toMatch(/placeholder=\{?label/);
  });

  it("failed submit moves focus to the first invalid field and shows a programmatic error summary whose links focus the fields", () => {
    expect(form).toMatch(/firstInvalidElementId\(check\.errors, prefix\)/);
    expect(form).toMatch(/document\.getElementById\(id\)\?\.focus\(\)/);
    expect(form).toMatch(/<Alert variant="destructive" data-testid="enquiry-error-summary">/);
    expect(read("src/components/ui/alert.tsx")).toMatch(/role="alert"/);
    expect(form).toMatch(/document\.getElementById\(item\.elementId\)\?\.focus\(\)/);
  });

  it("the sending state is announced politely, and the honeypot is hidden from people and assistive technology", () => {
    expect(form).toMatch(/role="status" aria-live="polite"/);
    expect(form).toMatch(/aria-hidden="true" className="absolute -left-\[10000px\]/);
    expect(form).toMatch(/tabIndex=\{-1\} autoComplete="off"/);
  });

  it("controls meet the 44px touch target and nothing has a fixed pixel width that could scroll a 320px screen sideways", () => {
    expect(fields).toMatch(/h-11/);
    expect(code("src/components/enquiry/ExpertTileFrame.tsx")).toMatch(/min-h-\[44px\]/);
    expect(form).toMatch(/min-h-11 w-full sm:w-auto/);
    for (const f of FEATURE_FILES.filter((x) => x.endsWith(".tsx"))) {
      const c = code(f);
      expect(c, f).not.toMatch(/\b(min-)?w-\[\d{3,}px\]/);
      expect(c, f).not.toMatch(/style=\{\{[^}]*width:\s*\d{3,}/);
    }
    expect(code("src/components/enquiry/DonorExpertTile.tsx")).toMatch(/w-\[calc\(100vw-1rem\)\]/);
    expect(code("src/components/enquiry/TaxJurisdictionTile.tsx")).toMatch(/w-\[calc\(100vw-1rem\)\]/);
  });

  it("layouts stack to a single column by default (grid-cols only from the sm breakpoint) so 320px never overflows", () => {
    for (const f of ["src/components/enquiry/ServiceEnquiryForm.tsx", "src/components/enquiry/queue/QueueFilters.tsx"]) {
      for (const m of code(f).matchAll(/(?<![\w-]:)\bgrid-cols-(\d)\b/g)) expect(m[1], `${f}: unprefixed grid-cols-${m[1]}`).toBe("1");
    }
  });

  it("status is never colour alone: the queue's badges pair an icon with a word, and tile states pair an icon with a word", () => {
    expect(code("src/components/enquiry/queue/StatusBadge.tsx")).toMatch(/<Icon[\s\S]*?aria-hidden="true"[\s\S]*?STATUS_LABELS\[status\]/);
    expect(code("src/components/enquiry/ExpertTileFrame.tsx")).toMatch(/\{stateIcon\}\s*\{stateLabel\}/);
  });

  it("the dialogs are the design system's Radix Dialog (focus trap, Escape, focus return) and the tile actions are real buttons with unique accessible names", () => {
    for (const f of ["src/components/enquiry/DonorExpertTile.tsx", "src/components/enquiry/TaxJurisdictionTile.tsx"]) expect(code(f), f).toMatch(/from "@\/components\/ui\/dialog"/);
    const frame = code("src/components/enquiry/ExpertTileFrame.tsx");
    expect(frame).toMatch(/<button\s+type="button"/);
    expect(frame).toMatch(/aria-label=\{actionAriaLabel\}/);
  });
});

describe("contact page", () => {
  it("is a canonical route with email as the only contact channel, prefilled but editable for signed-in users", () => {
    const page = code("src/pages/Contact.tsx");
    expect(page).toMatch(/serviceCode="general"/);
    expect(page).toMatch(/sourceFromSearch\(params\.get\("from"\)\)/);
    const form = code("src/components/enquiry/ServiceEnquiryForm.tsx");
    expect(form).toMatch(/user\?\.email/);
    expect(form).toMatch(/Prefilled from your account\. You can change it\./);
    for (const f of FEATURE_FILES) expect(code(f), f).not.toMatch(/name="(phone|tel|mobile)|type="tel"|preferred[-_ ]?contact/i);
  });

  it("the help/support wording is honest and offers no dead end", () => {
    expect(HELP_SUPPORT_COPY.body).toMatch(/reply by email/);
  });
});

describe("staff queue — server-side authorization, honest states", () => {
  const page = code("src/pages/admin/EnquiryQueue.tsx");

  it("is a lazy, separate chunk mounted at /admin/enquiries — and the route is a screen, not a security boundary", () => {
    const routes = read("src/lib/serviceEnquiry/serviceEnquiryRoutes.tsx");
    expect(routes).toMatch(/const EnquiryQueue = lazy\(\(\) => import\("@\/pages\/admin\/EnquiryQueue"\)\)/);
    expect(routes).toMatch(/path="\/admin\/enquiries"/);
    expect(read("src/pages/admin/EnquiryQueue.tsx")).toMatch(/not a security boundary/);
  });

  it("fetches NOTHING for a caller who is not platform staff: the list query is enabled only when the role check returned a staff role", () => {
    expect(page).toMatch(/enabled: Boolean\(role\.data\)/);
    expect(page).toMatch(/enabled: Boolean\(user\)/);
  });

  it("shows a permission-denied state for a null role or a 42501, a sign-in state when signed out, and loading / error / empty states", () => {
    expect(page).toMatch(/role\.error\.kind === "forbidden"/);
    expect(page).toMatch(/role\.isSuccess && role\.data === null/);
    for (const id of ["queue-permission-denied", "queue-signin", "queue-error", "queue-empty", "queue-role-error"]) expect(page, id).toContain(id);
    expect(page).toMatch(/role="status" aria-label="Loading/);
    expect(page).toMatch(/does not grant platform access/);
  });

  it("filters live in the URL (useSearchParams) and internal notes are never rendered anywhere except the staff detail", () => {
    expect(page).toMatch(/useSearchParams\(\)/);
    expect(page).toMatch(/parseQueueFilters\(params\)/);
    const users = walk(SRC).filter((f) => /Internal note|internal note/.test(code(rel(f)))).map(rel).sort();
    expect(users).toEqual(["src/components/enquiry/queue/EnquiryDetailSheet.tsx"]);
  });

  it("notification state is shown separately from enquiry status", () => {
    expect(page).toMatch(/<StatusBadge status=\{row\.status\} \/>/);
    expect(page).toMatch(/<NotificationChip label="Ack"/);
    expect(page).toMatch(/<NotificationChip label="Internal"/);
  });

  it("status changes offer only the transitions the SERVER returns, and pass the status the screen saw (stale views are refused)", () => {
    const detail = code("src/components/enquiry/queue/EnquiryDetailSheet.tsx");
    expect(detail).toMatch(/d\.allowed_transitions\.filter\(isEnquiryStatus\)/);
    expect(detail).toMatch(/transitionEnquiry\(id, to, detail\.data\?\.enquiry\.status \?\? ""/);
    expect(detail).toMatch(/case "stale":/);
  });
});

describe("integrity of what this feature did NOT touch", () => {
  it("leaves the authentication email hook and every existing Edge Function untouched", () => {
    const hook = read("supabase/functions/auth-email-hook/index.ts");
    expect(hook).toMatch(/createAuthEmailHandler/);
    expect(hook).not.toMatch(/service_enquir|submit-service-enquiry/);
  });

  it("does not modify the frozen statements-workspace page or its gate (workspaceGate pins it)", () => {
    expect(read("src/pages/workspace/StatementsWorkspace.tsx")).not.toMatch(/enquir|contactHref/i);
  });

  it("never links the queue from public navigation", () => {
    for (const f of ["src/components/Header.tsx", "src/components/Footer.tsx", "src/pages/Index.tsx"]) expect(code(f), f).not.toMatch(/admin\/enquiries/);
  });
});
