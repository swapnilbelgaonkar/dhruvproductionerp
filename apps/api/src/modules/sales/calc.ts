/**
 * Quotation / order line maths (QUO-002). Integer paise throughout so totals never drift.
 *  net rate  = list rate − scheme (volume slab) discount − extra discount (applied in that order)
 *  taxable   = net rate × quantity
 *  intra-state: CGST = SGST = taxable × GST/2 ; inter-state: IGST = taxable × GST
 *  grand total rounded to the rupee; the difference is shown as round-off (BRD p.13 "statutory rounding")
 */
export interface LineIn { qty: number; listRate: number | string; schemePct: number; extraPct: number; gstRate: number }
export interface LineOut { rate: number; listAmount: number; taxable: number; cgst: number; sgst: number; igst: number; lineTotal: number }
export interface Totals { subTotal: number; discountTotal: number; taxableTotal: number; cgstTotal: number; sgstTotal: number; igstTotal: number; roundOff: number; grandTotal: number }

const half = (x: number) => Math.round(x + (x >= 0 ? 1e-9 : -1e-9)); // half-up, immune to 0.4999999 artefacts
export const toPaise = (v: number | string) => half(Number(v) * 100);
export const toRupees = (p: number) => p / 100;

export function calcLine(l: LineIn, interState: boolean): LineOut {
  const listP = toPaise(l.listRate);
  const rateP = half(listP * (1 - l.schemePct / 100) * (1 - l.extraPct / 100));
  const listAmount = half(listP * l.qty);
  const taxable = half(rateP * l.qty);
  let cgst = 0; let sgst = 0; let igst = 0;
  if (interState) igst = half((taxable * l.gstRate) / 100);
  else { cgst = half((taxable * l.gstRate) / 200); sgst = cgst; }
  return { rate: rateP, listAmount, taxable, cgst, sgst, igst, lineTotal: taxable + cgst + sgst + igst };
}

/**
 * Purchase line (PUR-006): rates are per base unit and may carry 4 decimals (₹/kg); amounts are rounded to the paisa once, on the line.
 * An unregistered vendor charges no GST (reverse charge is outside this release).
 */
export function calcPurchaseLine(l: { qty: number; rate: number; discountPct: number; gstRate: number }, interState: boolean, gstApplies = true): LineOut & { netRate: number } {
  const netRate = half(l.rate * (1 - l.discountPct / 100) * 10000) / 10000;
  const listAmount = half(l.qty * l.rate * 100);
  const taxable = half(l.qty * netRate * 100);
  const g = gstApplies ? l.gstRate : 0;
  let cgst = 0; let sgst = 0; let igst = 0;
  if (interState) igst = half((taxable * g) / 100);
  else { cgst = half((taxable * g) / 200); sgst = cgst; }
  return { netRate, rate: half(netRate * 100), listAmount, taxable, cgst, sgst, igst, lineTotal: taxable + cgst + sgst + igst };
}

export function calcTotals(lines: LineOut[]): Totals {
  const sum = (k: keyof LineOut) => lines.reduce((a, l) => a + l[k], 0);
  const subTotal = sum('listAmount');
  const taxableTotal = sum('taxable');
  const gross = sum('lineTotal');
  const grandTotal = half(gross / 100) * 100;
  return { subTotal, discountTotal: subTotal - taxableTotal, taxableTotal, cgstTotal: sum('cgst'), sgstTotal: sum('sgst'), igstTotal: sum('igst'), roundOff: grandTotal - gross, grandTotal };
}

/** The scheme discount for a quantity is the best slab whose minimum quantity is reached. */
export function schemeFor(slabs: { minQty: number; discountPct: number }[], qty: number) {
  return slabs.filter((s) => qty >= s.minQty).reduce((best, s) => Math.max(best, s.discountPct), 0);
}

export function amountInWords(rupees: number): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n: number) => (n < 20 ? ones[n]! : `${tens[Math.floor(n / 10)]}${n % 10 ? ' ' + ones[n % 10] : ''}`);
  const three = (n: number) => (n >= 100 ? `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' + two(n % 100) : ''}` : two(n));
  let n = Math.round(rupees);
  if (n === 0) return 'Zero Rupees Only';
  const parts: string[] = [];
  for (const [div, name] of [[10000000, 'Crore'], [100000, 'Lakh'], [1000, 'Thousand']] as const) {
    if (n >= div) { parts.push(`${three(Math.floor(n / div))} ${name}`); n %= div; }
  }
  if (n) parts.push(three(n));
  return `Rupees ${parts.join(' ')} Only`;
}
