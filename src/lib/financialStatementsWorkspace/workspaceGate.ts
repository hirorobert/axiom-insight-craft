// financialStatementsWorkspace/workspaceGate.ts — the single canonical feature
// gate for the integrated financial-statements workspace.
//
// A plain source-controlled constant, deliberately NOT a VITE_* variable, a
// runtime setting, a query parameter or a stored preference: production
// cannot enable it through browser or deployment configuration. Flipping it
// requires a reviewed code change.
//
// While false:
//   - the Statements stage renders exactly what it rendered before this
//     feature existed (the workspace is never mounted, and is loaded through
//     a lazy import that is never evaluated);
//   - no workspace hook, adapter, evaluation or persistence code runs;
//   - the only place the workspace can render is the dev-server-only browser
//     harness, and only when import.meta.env.DEV is true (see
//     isWorkspaceRenderable, which the component itself enforces).
//
// Do not enable this before the workspace is complete and reviewed: it is an
// internal-preview foundation (see FINANCIAL_STATEMENT_PERSISTENCE_ENABLED and
// DOCUMENT_REVIEW_ENABLED, which are independent gates and also false).
export const FINANCIAL_STATEMENTS_WORKSPACE_ENABLED = false;

/** Pure: the workspace may render only when the gate is on, or in a dev build (the non-production harness). */
export function isWorkspaceRenderable(flagEnabled: boolean, isDevBuild: boolean): boolean {
  return flagEnabled || isDevBuild;
}
