import { describe, expect, it } from 'vitest';
import { amountInWords, calcLine, calcTotals, schemeFor } from '../src/modules/sales/calc';

describe('Quotation maths (QUO-002)', () => {
  it('splits intra-state GST into CGST + SGST and rounds the grand total to the rupee', () => {
    // 20 pouches × ₹245.50, 5% scheme, 2% extra, 5% GST
    const l = calcLine({ qty: 20, listRate: '245.50', schemePct: 5, extraPct: 2, gstRate: 5 }, false);
    expect(l.rate).toBe(22856);           // 245.50 × 0.95 × 0.98 = 228.5605 → ₹228.56
    expect(l.taxable).toBe(457120);       // ₹4,571.20
    expect(l.cgst).toBe(11428);           // 2.5% = ₹114.28
    expect(l.sgst).toBe(11428);
    expect(l.igst).toBe(0);
    const t = calcTotals([l]);
    expect(t.subTotal).toBe(491000);
    expect(t.discountTotal).toBe(33880);
    expect(t.grandTotal).toBe(480000);    // 4,799.76 → 4,800
    expect(t.roundOff).toBe(24);
  });
  it('uses IGST across states', () => {
    const l = calcLine({ qty: 3, listRate: 1000, schemePct: 0, extraPct: 0, gstRate: 18 }, true);
    expect([l.cgst, l.sgst, l.igst]).toEqual([0, 0, 54000]);
  });
  it('avoids floating-point half-paise errors', () => {
    expect(calcLine({ qty: 1, listRate: '1.005', schemePct: 0, extraPct: 0, gstRate: 0 }, false).taxable).toBe(101);
  });
  it('picks the best slab reached', () => {
    const slabs = [{ minQty: 10, discountPct: 2 }, { minQty: 50, discountPct: 5 }];
    expect([schemeFor(slabs, 9), schemeFor(slabs, 10), schemeFor(slabs, 75)]).toEqual([0, 2, 5]);
  });
  it('writes amounts in Indian words', () => {
    expect(amountInWords(480000)).toBe('Rupees Four Lakh Eighty Thousand Only');
    expect(amountInWords(12345678)).toBe('Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only');
  });
});
