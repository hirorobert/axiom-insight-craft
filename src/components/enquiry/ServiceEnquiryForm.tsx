// ServiceEnquiryForm — the ONE enquiry form. The contact page, the donor/funder dialog and the tax expert dialog all render this
// component, and it submits only through submitServiceEnquiry (the submit-service-enquiry Edge Function).
//
// Behaviour (each is covered by tests or by the pure model in src/lib/serviceEnquiry/formModel.ts):
//   * email is the only contact channel — no phone number, no preferred-contact-method field;
//   * validation uses the SAME contract as the server, with field-level messages, an error summary, and focus on the first invalid field;
//   * an immediate in-flight guard plus the server idempotency key make double submission impossible;
//   * a page refresh after success shows the stored receipt (never a blank form that could be resubmitted);
//   * no file input exists anywhere in this component, and nothing is inferred (no country, no donor rule, no jurisdiction).

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { HONEYPOT_FIELD, LIMITS, REPORT_TYPES, REPORTING_FREQUENCIES, requestFingerprint, type FieldError, type ServiceCode, type SourceContext } from "@/lib/serviceEnquiry/contract";
import { submitServiceEnquiry } from "@/lib/serviceEnquiry/client";
import { ENQUIRY_FORM_COPY, ENQUIRY_NOTICES, REPORT_TYPE_LABELS, REPORTING_FREQUENCY_LABELS } from "@/lib/serviceEnquiry/copy";
import {
  EMPTY_FORM_VALUES,
  buildErrorSummary,
  buildWireRequest,
  checkForm,
  describeFieldError,
  errorElementId,
  fieldElementId,
  firstInvalidElementId,
  type EnquiryFormValues,
} from "@/lib/serviceEnquiry/formModel";
import { clearAttempt, clearReceipt, loadAttempt, loadReceipt, resolveAttempt, saveAttempt, saveReceipt } from "@/lib/serviceEnquiry/receiptStore";
import type { EnquiryReceipt } from "@/lib/serviceEnquiry/contract";
import { countryOptions } from "@/lib/serviceEnquiry/jurisdictionPathways";
import { CHALLENGE_SITE_KEY, challengeState } from "@/lib/serviceEnquiry/challenge";
import { EnquiryReceiptView } from "./EnquiryReceiptView";
import { ChallengeWidget } from "./ChallengeWidget";
import { SelectField, TextAreaField, TextField } from "./EnquiryFields";

// Built on first use: Intl.DisplayNames for ~250 regions is not needed until a country selector actually renders.
let countryChoices: { value: string; label: string }[] | null = null;
const getCountryChoices = (): { value: string; label: string }[] => (countryChoices ??= countryOptions().map((c) => ({ value: c.code, label: c.name })));

export type EnquiryVariant = "general" | "donor" | "tax";

export interface ServiceEnquiryFormProps {
  /** Storage key and DOM id prefix; unique per form purpose (e.g. "contact", "donor", "tax-KE"). */
  formKey: string;
  variant: EnquiryVariant;
  serviceCode: ServiceCode;
  sourceContext: SourceContext;
  /** General variant only: the services the person may choose between. */
  serviceChoices?: readonly { code: ServiceCode; label: string }[];
  /** Tax variant only: the jurisdiction chosen by the person. Shown throughout submission and never changed silently. */
  jurisdiction?: { code: string; name: string; source: "user_selected" | "company_setting_confirmed" };
  defaultSubject?: string;
  /** Visible service/jurisdiction context, kept on screen during submission. */
  contextSummary?: ReactNode;
  /** Overrides the submit button wording (e.g. the pathway's own action label). */
  submitLabel?: string;
}

const readString = (v: unknown): string => (typeof v === "string" ? v : "");

export function ServiceEnquiryForm({ formKey, variant, serviceCode, sourceContext, serviceChoices, jurisdiction, defaultSubject, contextSummary, submitLabel }: ServiceEnquiryFormProps) {
  const { user } = useAuth();
  const prefix = `enq-${formKey}`.replace(/[^a-zA-Z0-9-]/g, "-");

  const [values, setValues] = useState<EnquiryFormValues>(() => ({
    ...EMPTY_FORM_VALUES,
    name: readString(user?.user_metadata?.full_name) || readString(user?.user_metadata?.name),
    email: user?.email ?? "",
    subject: defaultSubject ?? "",
  }));
  // The session resolves asynchronously, so a cold load of this page mounts with no user. When it arrives, fill the identity
// fields — but never overwrite anything the visitor has already typed.
  const identityTouched = useRef(false);
  useEffect(() => {
    if (!user || identityTouched.current) return;
    const name = readString(user.user_metadata?.full_name) || readString(user.user_metadata?.name);
    const email = user.email ?? "";
    setValues((prev) => ({ ...prev, name: prev.name === "" ? name : prev.name, email: prev.email === "" ? email : prev.email }));
  }, [user]);

  const [choice, setChoice] = useState<ServiceCode>(serviceCode);
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<EnquiryReceipt | null>(() => loadReceipt(formKey));
  const inFlight = useRef(false);
  // Anonymous visitors complete a challenge whose token the SERVER verifies. Signed-in users skip it (the server confirms the
  // session); if the server says the session is not valid it asks for the challenge and `forceChallenge` shows it.
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [challengeReset, setChallengeReset] = useState(0);
  const [forceChallenge, setForceChallenge] = useState(false);
  const challenge = challengeState({ signedIn: Boolean(user), forced: forceChallenge, siteKey: CHALLENGE_SITE_KEY });

  const activeService: ServiceCode = variant === "general" ? choice : serviceCode;
  const set = useCallback(<K extends keyof EnquiryFormValues>(key: K, v: EnquiryFormValues[K]) => {
    if (key === "name" || key === "email") identityTouched.current = true;
    setValues((prev) => ({ ...prev, [key]: v }));
  }, []);
  const setPayload = useCallback((key: string, v: string) => setValues((prev) => ({ ...prev, payload: { ...prev.payload, [key]: v } })), []);

  const errorFor = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of errors) if (!m.has(e.field)) m.set(e.field, describeFieldError(e.field, e.code));
    return (field: string) => m.get(field);
  }, [errors]);
  const summary = useMemo(() => buildErrorSummary(errors, prefix), [errors, prefix]);

  const focusElement = (id: string | null) => {
    if (id) window.requestAnimationFrame(() => document.getElementById(id)?.focus());
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return; // the guard is synchronous: a second click in the same tick can never pass
    inFlight.current = true;
    setSubmitting(true);
    setNotice(null);
    try {
      // The jurisdiction (tax) is fixed by the person's own selection and travels with the request; nothing is filled in silently.
      const effective: EnquiryFormValues = jurisdiction
        ? { ...values, country: jurisdiction.code, payload: { ...values.payload, jurisdiction_source: jurisdiction.source } }
        : values;
      const ctx = { serviceCode: activeService, sourceContext };
      const check = checkForm(effective, ctx);
      if (check.kind === "invalid") {
        setErrors(check.errors);
        focusElement(firstInvalidElementId(check.errors, prefix));
        return;
      }
      setErrors([]);

      if (challenge === "unavailable") {
        setNotice(ENQUIRY_FORM_COPY.challengeUnavailable); // no site key in this build: refuse to send unprotected
        return;
      }
      if (challenge === "required" && !challengeToken) {
        setNotice(ENQUIRY_FORM_COPY.challengeIncomplete);
        return;
      }

      const fingerprint = await requestFingerprint(check.normalized);
      const attempt = resolveAttempt(loadAttempt(formKey), fingerprint, () => crypto.randomUUID());
      saveAttempt(formKey, attempt);

      const outcome = await submitServiceEnquiry(buildWireRequest(effective, ctx, attempt.key, challenge === "required" ? challengeToken : null));
      if (outcome.kind !== "receipt") {
        // A challenge token is single-use: whatever went wrong, the next attempt needs a fresh one.
        setChallengeToken(null);
        setChallengeReset((n) => n + 1);
      }
      switch (outcome.kind) {
        case "receipt":
          saveReceipt(formKey, outcome.receipt);
          clearAttempt(formKey);
          setReceipt(outcome.receipt);
          break;
        case "invalid":
          setErrors(outcome.fields);
          focusElement(firstInvalidElementId(outcome.fields, prefix));
          if (outcome.fields.length === 0) setNotice(ENQUIRY_FORM_COPY.unavailable);
          break;
        case "rate_limited":
          setNotice(ENQUIRY_FORM_COPY.rateLimited);
          break;
        case "challenge":
          setForceChallenge(true);
          setNotice(ENQUIRY_FORM_COPY.challengeFailed);
          break;
        case "conflict":
          clearAttempt(formKey); // the next send is a new enquiry with a new key
          setNotice(ENQUIRY_FORM_COPY.conflict);
          break;
        default:
          setNotice(ENQUIRY_FORM_COPY.unavailable); // the key is kept: a retry with the same content is a safe replay
      }
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  function startAnother() {
    clearReceipt(formKey);
    clearAttempt(formKey);
    setReceipt(null);
    setValues((prev) => ({ ...EMPTY_FORM_VALUES, name: prev.name, email: prev.email, subject: defaultSubject ?? "" }));
    setErrors([]);
    setNotice(null);
  }

  if (receipt) return <EnquiryReceiptView receipt={receipt} onAnother={startAnother} />;

  const id = (field: string) => fieldElementId(prefix, field);

  return (
    <form noValidate onSubmit={handleSubmit} aria-labelledby={`${prefix}-title`} className="relative space-y-5" data-testid="service-enquiry-form" data-variant={variant} data-service={activeService} data-source={sourceContext}>
      <p id={`${prefix}-title`} className="sr-only">
        {ENQUIRY_FORM_COPY.generalHeading}
      </p>

      {contextSummary && <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">{contextSummary}</div>}

      <ul className="space-y-1 text-sm text-muted-foreground" data-testid="enquiry-notices">
        <li>{ENQUIRY_NOTICES.sensitive}</li>
        <li>{ENQUIRY_NOTICES.noEngagement}</li>
        <li>{ENQUIRY_NOTICES.review}</li>
      </ul>

      {summary.length > 0 && (
        <Alert variant="destructive" data-testid="enquiry-error-summary">
          <AlertTitle>{ENQUIRY_FORM_COPY.errorSummaryTitle}</AlertTitle>
          <AlertDescription>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {summary.map((item) => (
                <li key={item.field}>
                  <a
                    href={`#${item.elementId}`}
                    className="underline underline-offset-2"
                    onClick={(e) => {
                      e.preventDefault();
                      document.getElementById(item.elementId)?.focus();
                    }}
                  >
                    {item.message}
                  </a>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {notice && (
        <Alert variant="destructive" data-testid="enquiry-notice">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      {variant === "general" && serviceChoices && serviceChoices.length > 1 && (
        <SelectField
          prefix={prefix}
          field="service_choice"
          label="What is this about?"
          value={choice}
          onChange={(v) => {
            const found = serviceChoices.find((s) => s.code === v);
            if (found) setChoice(found.code);
          }}
          options={serviceChoices.map((s) => ({ value: s.code, label: s.label }))}
          placeholder="Choose a topic"
        />
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        <TextField prefix={prefix} field="name" label="Your name" value={values.name} onChange={(v) => set("name", v)} autoComplete="name" error={errorFor("name")} />
        <TextField prefix={prefix} field="email" label="Email address" type="email" inputMode="email" autoComplete="email" value={values.email} onChange={(v) => set("email", v)} error={errorFor("email")} hint={user ? "Prefilled from your account. You can change it." : undefined} />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <TextField prefix={prefix} field="organization" label="Organisation" optional autoComplete="organization" value={values.organization} onChange={(v) => set("organization", v)} error={errorFor("organization")} />
        {variant === "general" && (
          <SelectField
            prefix={prefix}
            field="country"
            label="Country"
            optional
            value={values.country}
            onChange={(v) => set("country", v)}
            options={getCountryChoices()}
            placeholder="Select a country"
            autoComplete="country"
            error={errorFor("country")}
          />
        )}
      </div>

      {variant === "donor" && (
        <fieldset className="space-y-5 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-semibold text-foreground">About the award or programme</legend>
          <SelectField
            prefix={prefix}
            field="payload.report_type"
            label="Report type"
            optional
            value={values.payload.report_type ?? ""}
            onChange={(v) => setPayload("report_type", v)}
            options={REPORT_TYPES.map((t) => ({ value: t, label: REPORT_TYPE_LABELS[t] }))}
            placeholder="Select a report type"
            error={errorFor("payload.report_type")}
          />
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField prefix={prefix} field="payload.donor_name" label="Donor or funder name" optional value={values.payload.donor_name ?? ""} onChange={(v) => setPayload("donor_name", v)} error={errorFor("payload.donor_name")} />
            <TextField prefix={prefix} field="payload.project_name" label="Project or programme name" optional value={values.payload.project_name ?? ""} onChange={(v) => setPayload("project_name", v)} error={errorFor("payload.project_name")} />
            <TextField prefix={prefix} field="payload.reporting_period" label="Reporting period" optional hint="For example FY2026 Q1" value={values.payload.reporting_period ?? ""} onChange={(v) => setPayload("reporting_period", v)} error={errorFor("payload.reporting_period")} />
            <SelectField
              prefix={prefix}
              field="payload.reporting_frequency"
              label="Reporting frequency"
              optional
              value={values.payload.reporting_frequency ?? ""}
              onChange={(v) => setPayload("reporting_frequency", v)}
              options={REPORTING_FREQUENCIES.map((f) => ({ value: f, label: REPORTING_FREQUENCY_LABELS[f] }))}
              placeholder="Select a frequency"
              error={errorFor("payload.reporting_frequency")}
            />
            <TextField prefix={prefix} field="payload.currency" label="Currency" optional hint="Three-letter code, such as USD" maxLength={3} value={values.payload.currency ?? ""} onChange={(v) => setPayload("currency", v.toUpperCase())} error={errorFor("payload.currency")} />
            <TextField prefix={prefix} field="payload.deadline" label="Deadline" type="date" optional value={values.payload.deadline ?? ""} onChange={(v) => setPayload("deadline", v)} error={errorFor("payload.deadline")} />
          </div>
          <TextAreaField prefix={prefix} field="payload.additional_context" label="Additional context" optional rows={4} maxLength={LIMITS.additionalContext.max} value={values.payload.additional_context ?? ""} onChange={(v) => setPayload("additional_context", v)} error={errorFor("payload.additional_context")} />
        </fieldset>
      )}

      {variant === "tax" && (
        <TextField prefix={prefix} field="payload.tax_period" label="Tax period" optional hint="For example FY2025" value={values.payload.tax_period ?? ""} onChange={(v) => setPayload("tax_period", v)} error={errorFor("payload.tax_period")} />
      )}

      <TextField prefix={prefix} field="subject" label="Subject" value={values.subject} onChange={(v) => set("subject", v)} error={errorFor("subject")} />
      <TextAreaField prefix={prefix} field="message" label="Message" maxLength={LIMITS.message.max} value={values.message} onChange={(v) => set("message", v)} error={errorFor("message")} />

      <div className="space-y-1.5">
        <div className="flex items-start gap-3">
          <Checkbox
            id={id("privacy_acknowledged")}
            checked={values.privacy}
            onCheckedChange={(c) => set("privacy", c === true)}
            aria-invalid={Boolean(errorFor("privacy_acknowledged"))}
            aria-describedby={errorFor("privacy_acknowledged") ? errorElementId(prefix, "privacy_acknowledged") : undefined}
            className="mt-1 h-5 w-5"
          />
          <Label htmlFor={id("privacy_acknowledged")} className="min-h-11 cursor-pointer text-sm font-normal leading-relaxed text-foreground">
            {ENQUIRY_FORM_COPY.privacyLabel}{" "}
            <Link to="/privacy" className="underline underline-offset-2" target="_blank" rel="noreferrer">
              Privacy notice
            </Link>
          </Label>
        </div>
        {errorFor("privacy_acknowledged") && (
          <p id={errorElementId(prefix, "privacy_acknowledged")} className="text-sm text-destructive">
            <span className="sr-only">Error: </span>
            {errorFor("privacy_acknowledged")}
          </p>
        )}
      </div>

      {/* Honeypot: invisible to people and assistive technology; a value here means an automated submission. */}
      <div aria-hidden="true" className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden">
        <label>
          Leave this field empty
          <input type="text" name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" value={values.honeypot} onChange={(e) => set("honeypot", e.target.value)} />
        </label>
      </div>

      {challenge === "required" && CHALLENGE_SITE_KEY && <ChallengeWidget siteKey={CHALLENGE_SITE_KEY} resetKey={challengeReset} onToken={setChallengeToken} />}
      {challenge === "unavailable" && (
        <p role="alert" className="text-sm text-destructive" data-testid="challenge-unavailable">
          {ENQUIRY_FORM_COPY.challengeUnavailable}
        </p>
      )}

      <p role="status" aria-live="polite" className="sr-only">
        {submitting ? "Sending your enquiry" : ""}
      </p>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button type="submit" variant="hero" disabled={submitting} aria-busy={submitting} className="min-h-11 w-full sm:w-auto" data-testid="enquiry-submit">
          {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {submitting ? ENQUIRY_FORM_COPY.submitting : (submitLabel ?? ENQUIRY_FORM_COPY.submit)}
        </Button>
        <p className="text-xs text-muted-foreground">{ENQUIRY_NOTICES.emailOnly}</p>
      </div>
    </form>
  );
}
