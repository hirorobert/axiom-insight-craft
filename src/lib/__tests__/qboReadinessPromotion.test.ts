import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { candidateStatements, renderPromotion, CANDIDATE, SOURCE } from '../../../scripts/release/qboReadinessPromotion.mjs';
import { parseAtomicEnvelope } from '../../../scripts/ci/atomicEnvelope.mjs';
import { submittedForm, checkReleaseEntry } from '../../../scripts/ci/releaseJournal.mjs';

describe('QBO readiness canonical promotion', () => {
  const candidate = fs.readFileSync(CANDIDATE);
  const authored = fs.readFileSync(`supabase/migrations/${SOURCE}`);
  it('preserves every reviewed non-transaction statement in one atomic statement', () => {
    expect(authored.toString()).toBe(renderPromotion(candidate));
    expect(parseAtomicEnvelope(authored.toString()).statements).toEqual(candidateStatements(candidate));
  });
  it('rejects edited or truncated candidate bytes before rendering', () => {
    const changed = Buffer.from(candidate); changed[100] ^= 1;
    expect(() => renderPromotion(changed)).toThrow(/fingerprint mismatch/);
    expect(() => renderPromotion(candidate.subarray(0, -1))).toThrow(/fingerprint mismatch/);
  });
  it('accepts only the registered complete submission forms', () => {
    expect(submittedForm(SOURCE, authored, authored)).toBe('identical');
    expect(submittedForm(SOURCE, authored, authored.subarray(0, -1))).toBe('final_lf_removed');
    expect(submittedForm(SOURCE, authored, Buffer.concat([authored, Buffer.from(' ')]))).toBeNull();
    expect(submittedForm(SOURCE, authored, candidate)).toBeNull();
  });
  it('recognizes the installed receipt and rejects a one-byte change to its mirror', () => {
    const tag = '0101_qbo_readiness_controls';
    const mirror = fs.readFileSync(`drizzle/migrations/${tag}.sql`);
    const source = (name: string) => name === SOURCE ? authored : null;
    expect(mirror.equals(authored)).toBe(true);
    expect(checkReleaseEntry(tag, mirror.toString(), source).problems).toEqual([]);
    const changed = Buffer.from(mirror); changed[0] ^= 1;
    expect(checkReleaseEntry(tag, changed.toString(), source).problems.length).toBeGreaterThan(0);
  });
});
