/**
 * Ω2-GR1 — Immutable Webhook Receipt Model repair (HIGH-3).
 *
 * Codex demonstrated a genuine internal contradiction in the rejected
 * candidate: `payment_webhook_receipts` had a BEFORE UPDATE/DELETE trigger
 * that unconditionally raised, while the webhook Edge Function inserted a
 * PENDING row and then UPDATEd `signature_valid`/`processing_result` onto
 * that same row — every one of those UPDATEs would fail at the trigger the
 * moment a real webhook arrived.
 *
 * Repair model: `payment_webhook_receipts` is now a pure immutable
 * OBSERVATION (no mutable-looking columns at all); processing OUTCOMES are
 * separate append-only rows in `payment_webhook_processing_events`, one per
 * attempt. Both tables are guarded by their own append-only trigger, and —
 * unlike the migration, which is SQL and cannot be exercised without a live
 * database (same limitation documented in globalCommerceModel.test.ts) —
 * the Edge Function IS plain TypeScript with no Deno-only imports, so its
 * exact source text can be checked directly for the specific contradiction
 * Codex found: no UPDATE/`.update(` call may ever target
 * payment_webhook_receipts.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const MIGRATION_PATH = path.join(
  __dirname,
  "../../../../../supabase/migrations/20260905200000_omega2_commercial_payments.sql",
);
const WEBHOOK_FN_PATH = path.join(
  __dirname,
  "../../../../../supabase/functions/commercial-payment-webhook/index.ts",
);

function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, "");
}

function stripTsComments(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const migrationSql = stripSqlComments(fs.readFileSync(MIGRATION_PATH, "utf-8"));
const webhookSrc = stripTsComments(fs.readFileSync(WEBHOOK_FN_PATH, "utf-8"));

describe("payment_webhook_receipts — pure immutable observation (Ω2-GR1)", () => {
  it("no longer defines signature_valid or processing_result columns", () => {
    const tableBlock = migrationSql.match(/CREATE TABLE public\.payment_webhook_receipts\s*\([\s\S]*?\);/);
    expect(tableBlock).not.toBeNull();
    expect(tableBlock![0]).not.toMatch(/signature_valid/);
    expect(tableBlock![0]).not.toMatch(/processing_result/);
  });

  it("still carries an unconditional BEFORE UPDATE OR DELETE append-only trigger", () => {
    expect(migrationSql).toMatch(
      /CREATE TRIGGER trg_pwr_immutable\s+BEFORE UPDATE OR DELETE ON public\.payment_webhook_receipts/,
    );
  });

  it("has no unique constraint on attacker-influenceable columns (saff_reference, provider_event_id)", () => {
    const tableBlock = migrationSql.match(/CREATE TABLE public\.payment_webhook_receipts\s*\([\s\S]*?\);/)![0];
    expect(tableBlock).not.toMatch(/UNIQUE[\s\S]*saff_reference/);
    expect(tableBlock).not.toMatch(/UNIQUE[\s\S]*provider_event_id/);
  });
});

describe("payment_webhook_processing_events — append-only processing outcomes (Ω2-GR1)", () => {
  it("exists as its own table, foreign-keyed to payment_webhook_receipts", () => {
    expect(migrationSql).toMatch(/CREATE TABLE public\.payment_webhook_processing_events/);
    expect(migrationSql).toMatch(/FOREIGN KEY \(receipt_id\) REFERENCES public\.payment_webhook_receipts\(id\)/);
  });

  it("carries its own unconditional BEFORE UPDATE OR DELETE append-only trigger", () => {
    expect(migrationSql).toMatch(
      /CREATE TRIGGER trg_pwpe_immutable\s+BEFORE UPDATE OR DELETE ON public\.payment_webhook_processing_events/,
    );
  });

  it("carries the processing_result CHECK enum values the webhook function actually inserts", () => {
    const tableBlock = migrationSql.match(/CREATE TABLE public\.payment_webhook_processing_events\s*\([\s\S]*?\);/)![0];
    for (const value of [
      "PROCESSED", "INVALID_SIGNATURE", "REPLAY", "VERIFICATION_FAILED",
      "AMOUNT_MISMATCH", "CURRENCY_MISMATCH", "REFERENCE_MISMATCH",
      "REFERENCE_MISSING", "ERROR",
    ]) {
      expect(tableBlock).toMatch(new RegExp(`'${value}'`));
    }
  });

  it("has no unique constraint on attacker-influenceable columns (a legitimate retry must be able to insert again)", () => {
    const tableBlock = migrationSql.match(/CREATE TABLE public\.payment_webhook_processing_events\s*\([\s\S]*?\);/)![0];
    expect(tableBlock).not.toMatch(/UNIQUE/);
  });
});

describe("commercial-payment-webhook Edge Function — no UPDATE against the immutable receipt table (Ω2-GR1)", () => {
  it("never calls .from('payment_webhook_receipts').update(...) or any UPDATE on it", () => {
    // The exact contradiction Codex found: an .update() call chained off a
    // payment_webhook_receipts query. None may exist anywhere in this file.
    expect(webhookSrc).not.toMatch(/payment_webhook_receipts'\)\s*\n?\s*\.update\(/);
    expect(webhookSrc).not.toMatch(/from\('payment_webhook_receipts'\)[\s\S]{0,80}\.update\(/);
  });

  it("inserts into payment_webhook_receipts exactly once, before Gate A runs", () => {
    const insertMatches = webhookSrc.match(/\.from\('payment_webhook_receipts'\)\s*\n?\s*\.insert\(/g) ?? [];
    expect(insertMatches.length).toBe(1);

    const insertIndex = webhookSrc.indexOf(".from('payment_webhook_receipts')");
    const gateAIndex = webhookSrc.indexOf("verifyWebhookAuthenticity(");
    expect(insertIndex).toBeGreaterThan(-1);
    expect(gateAIndex).toBeGreaterThan(-1);
    expect(insertIndex).toBeLessThan(gateAIndex);
  });

  it("aborts BEFORE Gate A when the receipt insert fails — no durable evidence, no processing", () => {
    // The failure branch must return out of the handler, never fall through
    // to verifyWebhookAuthenticity / adapter.verifyTransaction / the commit RPC.
    const receiptErrBlock = webhookSrc.match(
      /if \(receiptErr \|\| !receiptRow\) \{[\s\S]*?\n {2}\}/,
    );
    expect(receiptErrBlock).not.toBeNull();
    expect(receiptErrBlock![0]).toMatch(/return new Response/);
    expect(receiptErrBlock![0]).not.toMatch(/verifyWebhookAuthenticity/);
    expect(receiptErrBlock![0]).not.toMatch(/commit_verified_commercial_payment/);
  });

  it("records processing outcomes as inserts into payment_webhook_processing_events, never updates", () => {
    expect(webhookSrc).toMatch(/\.from\('payment_webhook_processing_events'\)\.insert\(/);
    expect(webhookSrc).not.toMatch(/payment_webhook_processing_events'\)[\s\S]{0,80}\.update\(/);
  });

  it("never calls commit_verified_commercial_payment before the receipt has been durably recorded", () => {
    const receiptInsertIndex = webhookSrc.indexOf(".from('payment_webhook_receipts')");
    const commitIndex = webhookSrc.indexOf("commit_verified_commercial_payment");
    expect(receiptInsertIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(-1);
    expect(receiptInsertIndex).toBeLessThan(commitIndex);
  });
});
