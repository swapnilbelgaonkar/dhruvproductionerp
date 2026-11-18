import { describe, expect, it } from 'vitest';
import { gstinCheckDigit, gstinMatchesPan, validateGstin } from './gst';

describe('GSTIN validation', () => {
  // Synthetic identifiers built from the algorithm, not real taxpayers.
  const base = '27AAAAA0000A1Z';
  const valid = base + gstinCheckDigit(base);

  it('accepts a GSTIN with a correct check digit', () => expect(validateGstin(valid)).toEqual({ valid: true }));
  it('rejects a wrong check digit', () => {
    const wrong = base + (valid.endsWith('0') ? '1' : '0');
    expect(validateGstin(wrong)).toEqual({ valid: false, reason: 'CHECKSUM' });
  });
  it('rejects 15 digits (the BRD "15-digit" wording is a format error)', () =>
    expect(validateGstin('271234567890123')).toEqual({ valid: false, reason: 'FORMAT' }));
  it('matches the embedded PAN', () => expect(gstinMatchesPan(valid, 'AAAAA0000A')).toBe(true));
});
