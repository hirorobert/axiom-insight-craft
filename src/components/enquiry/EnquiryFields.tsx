// Accessible field primitives for the enquiry forms.
//   * Persistent visible labels — a placeholder is never a label; optional fields say "(optional)" rather than relying on an asterisk.
//   * Errors are linked with aria-describedby and marked aria-invalid; they carry an icon AND text, so status never depends on colour alone.
//   * Every control is at least 44px tall (touch target) and full width, so nothing scrolls sideways at 320px.

import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { errorElementId, fieldElementId } from "@/lib/serviceEnquiry/formModel";

export const SELECT_CLASS =
  "flex h-11 w-full rounded-lg border border-border bg-secondary/50 px-3 py-2 text-base text-foreground transition-all duration-200 focus:border-primary focus:bg-secondary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm aria-[invalid=true]:border-destructive";

interface ShellProps {
  prefix: string;
  field: string;
  label: string;
  optional?: boolean;
  hint?: string;
  error?: string;
  children: (a11y: { id: string; "aria-invalid": boolean; "aria-describedby": string | undefined }) => ReactNode;
}

export function FieldShell({ prefix, field, label, optional, hint, error, children }: ShellProps) {
  const id = fieldElementId(prefix, field);
  const hintId = `${id}-hint`;
  const errId = errorElementId(prefix, field);
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
        {optional && <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}
      </Label>
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {children({ id, "aria-invalid": Boolean(error), "aria-describedby": describedBy })}
      {error && (
        <p id={errId} className="flex items-start gap-1.5 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            <span className="sr-only">Error: </span>
            {error}
          </span>
        </p>
      )}
    </div>
  );
}

interface TextFieldProps extends Omit<ShellProps, "children"> {
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "email" | "date";
  autoComplete?: string;
  maxLength?: number;
  inputMode?: "text" | "email";
  className?: string;
}

export function TextField({ value, onChange, type = "text", autoComplete, maxLength, inputMode, className, ...shell }: TextFieldProps) {
  return (
    <FieldShell {...shell}>
      {(a11y) => (
        <Input
          {...a11y}
          name={shell.field}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          inputMode={inputMode}
          maxLength={maxLength}
          className={cn("min-h-11", className)}
        />
      )}
    </FieldShell>
  );
}

interface TextAreaFieldProps extends Omit<ShellProps, "children"> {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  maxLength: number;
}

export function TextAreaField({ value, onChange, rows = 6, maxLength, ...shell }: TextAreaFieldProps) {
  return (
    <FieldShell {...shell}>
      {(a11y) => (
        <>
          <Textarea {...a11y} name={shell.field} value={value} onChange={(e) => onChange(e.target.value)} rows={rows} className="min-h-[120px] rounded-lg bg-secondary/50 text-base md:text-sm" />
          <p className="text-right text-xs text-muted-foreground" aria-hidden="true">
            {Array.from(value).length} / {maxLength}
          </p>
        </>
      )}
    </FieldShell>
  );
}

interface SelectFieldProps extends Omit<ShellProps, "children"> {
  value: string;
  onChange: (v: string) => void;
  options: readonly { value: string; label: string }[];
  placeholder: string;
  autoComplete?: string;
  disabled?: boolean;
}

export function SelectField({ value, onChange, options, placeholder, autoComplete, disabled, ...shell }: SelectFieldProps) {
  return (
    <FieldShell {...shell}>
      {(a11y) => (
        <select {...a11y} name={shell.field} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} disabled={disabled} className={SELECT_CLASS}>
          <option value="">{placeholder}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </FieldShell>
  );
}
