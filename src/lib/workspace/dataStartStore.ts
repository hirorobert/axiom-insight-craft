/**
 * dataStartStore — durable persistence of the data choice ("Import trial balance" / "Start without data").
 *
 * One `onboarding_progress` row per (user × company × period year): the table's own UNIQUE constraint makes the
 * write an idempotent upsert, so repeated clicks and concurrent requests converge on a single row. RLS confines a
 * user to their own rows in companies they belong to; no URL parameter, local flag or history entry is consulted.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { DATA_START_STEP, dataStartChoiceFromStep, type DataStartChoice } from "./onboardingState";

export interface DataStartPort {
  read(companyId: string, year: number): Promise<string | null>;
  upsert(companyId: string, year: number, step: string): Promise<void>;
}

export async function readDataStart(port: DataStartPort, companyId: string, year: number): Promise<DataStartChoice | null> {
  return dataStartChoiceFromStep(await port.read(companyId, year));
}

/** Records the choice. An already-recorded identical choice is a no-op; a different choice replaces it (the last decision wins). */
export async function recordDataStart(port: DataStartPort, companyId: string, year: number, choice: DataStartChoice): Promise<void> {
  if ((await readDataStart(port, companyId, year)) === choice) return;
  await port.upsert(companyId, year, DATA_START_STEP[choice]);
}

export function supabaseDataStartPort(supabase: SupabaseClient, userId: string): DataStartPort {
  return {
    async read(companyId, year) {
      const { data } = await supabase.from("onboarding_progress").select("current_step").eq("user_id", userId).eq("company_id", companyId).eq("period_year", year).maybeSingle();
      return (data?.current_step as string | undefined) ?? null;
    },
    async upsert(companyId, year, step) {
      const { error } = await supabase.from("onboarding_progress").upsert({ user_id: userId, company_id: companyId, period_year: year, current_step: step }, { onConflict: "user_id,company_id,period_year" });
      if (error) throw error;
    },
  };
}
