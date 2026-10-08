/**
 * The browser's path to an AI-assisted layout SUGGESTION (I1-C): the layout-assist Edge Function. Shown only after the
 * automatic reading could not read a sheet, and only when LAYOUT_ASSIST_ENABLED — a reviewed source constant that stays
 * false until a provider, its data-handling terms, a measured evaluation, the consent wording and budgets are approved
 * (the function itself ships with no provider wired). A suggestion is advisory: it fills the manual editor and arrives
 * with the server's whole-file validation; the person reviews every column and confirms through the existing layout path.
 */
import { interpret, type LayoutAnswer, type LayoutProfile, type LayoutReport } from "./layoutClient";

export const LAYOUT_ASSIST_ENABLED = false;

export type LayoutAssistInvoke = (name: "layout-assist", options: { body: Record<string, unknown> }) => Promise<{ data: unknown; error: unknown }>;
export interface LayoutSuggestion { status: "proposed"; runId: string; advisory: true; layout: LayoutProfile; report: LayoutReport; replay: boolean }

export function layoutAssistClient(invoke: LayoutAssistInvoke) {
  return {
    suggest: async (uploadId: string, sheetIndex: number, requestId: string): Promise<LayoutAnswer<LayoutSuggestion>> =>
      interpret<LayoutSuggestion>(await invoke("layout-assist", { body: { action: "suggest", uploadId, sheetIndex, requestId } })),
  };
}
export type LayoutAssistClient = ReturnType<typeof layoutAssistClient>;
