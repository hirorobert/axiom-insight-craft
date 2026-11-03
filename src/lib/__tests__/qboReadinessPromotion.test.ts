import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { candidateStatements, renderPromotion, CANDIDATE, SOURCE } from '../../../scripts/release/qboReadinessPromotion.mjs';
import { parseAtomicEnvelope } from '../../../scripts/ci/atomicEnvelope.mjs';
import { submittedForm } from '../../../scripts/ci/releaseJournal.mjs';

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
});
