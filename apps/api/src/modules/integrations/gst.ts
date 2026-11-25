import { createHash, randomInt } from 'node:crypto';
import { Router, type Request } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { withTx, type Db, type Tx } from '../../db/pool';
import { audit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, parse, str } from '../../lib/http';
import { financialYear } from '../../lib/numbering';
import { getSetting } from '../../lib/settings';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can, legalEntityScope } from '../../middleware/context';
import { syncLedger } from '../finance/ledger';
import { todayIST } from '../sales/quotations';
import { getIntegration, logCall, requireOn, type Integration } from './registry';

/**
 * GST integrations (FIN-019, LOG-005; D08, D27).
 *  - E-invoice: INV-01 JSON (schema 1.1) for B2B invoices and credit notes; IRN, acknowledgement and signed QR recorded against the document.
 *  - E-way bill: the NIC JSON for a dispatched shipment and its invoice; validity from the distance (Rule 138(10)).
 *  - Returns: GSTR-1 and GSTR-3B JSON in the GST portal offline-tool layout for one GSTIN and month; filing recorded with its ARN, after
 *    which that month's invoices and credit notes can no longer be cancelled.
 * MANUAL: the JSON is uploaded on the portal and the reply typed or pasted back. SIMULATED: a training imitation; results say SIMULATED.
 */
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => Number(v ?? 0);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const dmy = (v: unknown, sep = '/') => { const [y, m, d] = iso(v).split('-'); return `${d}${sep}${m}${sep}${y}`; };
const fy = (v: unknown) => financialYear(new Date(`${iso(v)}T00:00:00Z`));
const text = (n: number) => z.string().trim().min(1, 'Required').max(n);
const REASONS = { 1: 'Duplicate', 2: 'Data entry mistake', 3: 'Order cancelled', 4: 'Other' } as const;
type Problem = { field: string; message: string };

/** The real IRN is SHA-256 of supplier GSTIN, financial year, document type and number (NIC e-invoice API spec); the simulator uses the same rule. */
export const irnOf = (gstin: string, year: string, kind: string, docNo: string) => createHash('sha256').update(`${gstin}${year}${kind}${docNo}`).digest('hex');

async function seller(tx: Db | Tx, gstin: string | null) {
  if (!gstin) return null;
  return (await tx.query(`select g.gstin, g.state_code, g.trade_name, g.addr_line1, g.location, g.pincode, g.address, g.einvoice_applicable, le.name as legal_name
      from org.gst_registrations g join org.legal_entities le on le.id = g.legal_entity_id where g.gstin = $1`, [gstin])).rows[0] ?? null;
}
function partyBlock(p: Problem[], who: 'Seller' | 'Buyer', x: { gstin?: string | null; name?: string | null; addr?: string | null; loc?: string | null; pin?: string | null; st?: string | null }) {
  if (!x.gstin) p.push({ field: `${who}.Gstin`, message: `${who} GSTIN is missing` });
  if (!x.addr) p.push({ field: `${who}.Addr1`, message: `${who} address line is missing` });
  if (!x.loc) p.push({ field: `${who}.Loc`, message: `${who} city / location is missing` });
  if (!x.pin) p.push({ field: `${who}.Pin`, message: `${who} PIN code is missing` });
  return { Gstin: x.gstin ?? '', LglNm: x.name ?? '', Addr1: (x.addr ?? '').slice(0, 100), Loc: (x.loc ?? '').slice(0, 50), Pin: Number(x.pin ?? 0), Stcd: x.st ?? '' };
}

// ================================================================ e-invoice payloads
export async function einvoicePayload(tx: Db | Tx, kind: 'INV' | 'CRN', id: string) {
  const problems: Problem[] = [];
  const inv = (await tx.query(`select i.*, p.legal_name from sales.invoices i join mdm.parties p on p.id = i.party_id
      where i.id = ${kind === 'INV' ? '$1' : '(select invoice_id from sales.credit_notes where id = $1)'}`, [id])).rows[0];
  if (!inv) throw Errors.notFound(kind === 'INV' ? 'Invoice' : 'Credit note');
  const cn = kind === 'CRN' ? (await tx.query(`select * from sales.credit_notes where id = $1`, [id])).rows[0] : null;
  const doc = cn ?? inv;
  if (!inv.party_gstin) return { applicable: false, reason: 'The buyer is not GST-registered (B2C): no e-invoice is needed.', payload: null, problems, doc, inv };
  if (kind === 'INV' && inv.status !== 'Posted') return { applicable: false, reason: 'The invoice is cancelled.', payload: null, problems, doc, inv };
  if (cn && cn.status !== 'Approved') return { applicable: false, reason: 'Only an approved credit note gets an IRN.', payload: null, problems, doc, inv };
  const s = await seller(tx, inv.seller_gstin);
  if (s && !s.einvoice_applicable) return { applicable: false, reason: `GSTIN ${s.gstin} is marked as not required to e-invoice.`, payload: null, problems, doc, inv };
  const addr = (await tx.query(`select id, line1, line2, city, district, state_code, pincode from mdm.party_addresses where id = any($1::uuid[])`, [[inv.bill_to_id, inv.ship_to_id]])).rows;
  const bill = addr.find((a) => a.id === inv.bill_to_id); const ship = addr.find((a) => a.id === inv.ship_to_id);
  const uqc = await getSetting<string>(tx, 'gst.uqc.default', 'NOS');
  const lines = kind === 'INV'
    ? (await tx.query(`select line_no, description, hsn_code, qty, list_rate, rate, taxable, gst_rate, cgst, sgst, igst, line_total from sales.invoice_lines where invoice_id = $1 order by line_no`, [inv.id])).rows
    : (await tx.query(`select row_number() over (order by il.line_no) as line_no, il.description, il.hsn_code, cl.qty, il.rate as list_rate, il.rate, cl.taxable, cl.gst_rate, cl.cgst, cl.sgst, cl.igst, cl.line_total
        from sales.credit_note_lines cl join sales.invoice_lines il on il.id = cl.invoice_line_id where cl.credit_note_id = $1 order by il.line_no`, [id])).rows;
  const items = lines.map((l, i) => {
    const qty = l.qty == null ? 0 : num(l.qty);
    const unitPrice = qty ? num(l.list_rate) : num(l.taxable);
    const tot = r2(qty ? qty * unitPrice : num(l.taxable));
    return { SlNo: String(i + 1), PrdDesc: String(l.description).slice(0, 300), IsServc: 'N', HsnCd: l.hsn_code, Qty: qty, Unit: uqc, UnitPrice: unitPrice, TotAmt: tot,
      Discount: r2(Math.max(0, tot - num(l.taxable))), AssAmt: num(l.taxable), GstRt: num(l.gst_rate), IgstAmt: num(l.igst), CgstAmt: num(l.cgst), SgstAmt: num(l.sgst),
      CesRt: 0, CesAmt: 0, TotItemVal: num(l.line_total) };
  });
  for (const it of items) if (!/^[0-9]{4,8}$/.test(String(it.HsnCd))) problems.push({ field: `ItemList.${it.SlNo}.HsnCd`, message: `Line ${it.SlNo}: HSN ${it.HsnCd} is not 4–8 digits` });
  const payload = {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: kind, No: doc.doc_no, Dt: dmy(kind === 'INV' ? inv.invoice_date : cn.note_date) },
    SellerDtls: partyBlock(problems, 'Seller', { gstin: inv.seller_gstin, name: s?.legal_name, addr: s?.addr_line1, loc: s?.location, pin: s?.pincode, st: inv.seller_state }),
    BuyerDtls: { ...partyBlock(problems, 'Buyer', { gstin: inv.party_gstin, name: inv.legal_name, addr: [bill?.line1, bill?.line2].filter(Boolean).join(', '), loc: bill?.city, pin: bill?.pincode, st: bill?.state_code }), Pos: inv.place_of_supply },
    ...(ship && bill && ship.id !== bill.id ? { ShipDtls: { Gstin: inv.party_gstin, LglNm: inv.legal_name, Addr1: [ship.line1, ship.line2].filter(Boolean).join(', ').slice(0, 100), Loc: ship.city, Pin: Number(ship.pincode), Stcd: ship.state_code } } : {}),
    ItemList: items,
    ValDtls: { AssVal: num(doc.taxable_total), CgstVal: num(doc.cgst_total), SgstVal: num(doc.sgst_total), IgstVal: num(doc.igst_total), CesVal: 0, StCesVal: 0, Discount: 0, OthChrg: 0,
      RndOffAmt: num(doc.round_off), TotInvVal: num(doc.grand_total) },
    ...(cn ? { RefDtls: { PrecDocDtls: [{ InvNo: inv.doc_no, InvDt: dmy(inv.invoice_date) }] } } : {}),
  };
  const sum = r2(payload.ValDtls.AssVal + payload.ValDtls.CgstVal + payload.ValDtls.SgstVal + payload.ValDtls.IgstVal + payload.ValDtls.RndOffAmt);
  if (Math.abs(sum - payload.ValDtls.TotInvVal) > 0.011) problems.push({ field: 'ValDtls.TotInvVal', message: `Totals do not add up (${sum} ≠ ${payload.ValDtls.TotInvVal})` });
  return { applicable: true, reason: null, payload, problems, doc, inv };
}

/** Training imitation of the IRP reply; the QR content carries SIMULATED so nobody can mistake it for a signed one. */
function simulateIrp(payload: { SellerDtls: { Gstin: string }; BuyerDtls: { Gstin: string }; DocDtls: { Typ: string; No: string; Dt: string }; ValDtls: { TotInvVal: number }; ItemList: { HsnCd: string }[] }, year: string) {
  const irn = irnOf(payload.SellerDtls.Gstin, year, payload.DocDtls.Typ, payload.DocDtls.No);
  const ackNo = `1${String(Date.now()).slice(-9)}${String(randomInt(0, 99999)).padStart(5, '0')}`;
  const body = { data: JSON.stringify({ SellerGstin: payload.SellerDtls.Gstin, BuyerGstin: payload.BuyerDtls.Gstin, DocNo: payload.DocDtls.No, DocTyp: payload.DocDtls.Typ,
    DocDt: payload.DocDtls.Dt, TotInvVal: payload.ValDtls.TotInvVal, ItemCnt: payload.ItemList.length, MainHsnCode: payload.ItemList[0]?.HsnCd, Irn: irn, IrnDt: new Date().toISOString(), Simulated: true }) };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return { irn, ackNo, ackDate: new Date(), signedQr: `${b64({ alg: 'none', typ: 'SIMULATED' })}.${b64(body)}.SIMULATED` };
}

async function einvoiceRow(dbx: Db | Tx, kind: 'INV' | 'CRN', id: string) {
  return (await dbx.query(`select e.id, e.doc_kind as "docKind", e.doc_no as "docNo", e.mode, e.status, e.irn, e.ack_no as "ackNo", e.ack_date as "ackDate", e.signed_qr as "signedQr",
      e.cancel_reason as "cancelReason", e.cancel_remarks as "cancelRemarks", e.cancelled_at as "cancelledAt", e.created_at as "createdAt", u.full_name as "createdBy"
      from gst.einvoices e left join iam.users u on u.id = e.created_by where ${kind === 'INV' ? 'e.invoice_id' : 'e.credit_note_id'} = $1 order by e.created_at desc`, [id])).rows;
}

/** For the printed invoice: the active IRN and a QR image (the signed QR from the IRP; a simulated one is labelled so). */
export async function einvoiceForPrint(dbx: Db | Tx, kind: 'INV' | 'CRN', id: string) {
  const e = (await einvoiceRow(dbx, kind, id)).find((x) => x.status === 'Generated');
  if (!e) return null;
  return { irn: e.irn, ackNo: e.ackNo, ackDate: e.ackDate, mode: e.mode, simulated: e.mode === 'SIMULATED', qrDataUrl: await QRCode.toDataURL(e.signedQr, { errorCorrectionLevel: 'L', margin: 1 }) };
}

/** Used by invoice and credit-note cancellation: an active IRN must be cancelled on the IRP first, and a filed GSTR-1 month is closed. */
export async function assertGstAllowsCancel(tx: Tx, kind: 'INV' | 'CRN', id: string, gstin: string | null, docDate: unknown) {
  const live = (await tx.query(`select irn from gst.einvoices where ${kind === 'INV' ? 'invoice_id' : 'credit_note_id'} = $1 and status = 'Generated'`, [id])).rows[0];
  if (live) throw Errors.rule('IRN_ACTIVE', 'This document has an IRN. Cancel the e-invoice first (within 24 hours of its acknowledgement).');
  if (gstin && (await tx.query(`select 1 from gst.return_filings where gstin = $1 and return_type = 'GSTR1' and period = $2 and status = 'Filed'`, [gstin, iso(docDate).slice(0, 7)])).rowCount) {
    throw Errors.rule('RETURN_FILED', `GSTR-1 for ${iso(docDate).slice(0, 7)} is filed; issue a credit note instead.`);
  }
}

// ================================================================ e-way bill payload
async function ewbPayload(tx: Db | Tx, shipmentId: string, distanceKm: number | null) {
  const problems: Problem[] = [];
  const s = (await tx.query(`select s.*, w.address as wh_address, w.city as wh_city, w.pincode as wh_pincode, w.state_code as wh_state, t.name as tr_name, t.gstin as tr_gstin
      from logistics.shipments s join org.warehouses w on w.id = s.warehouse_id left join logistics.transporters t on t.id = s.transporter_id where s.id = $1`, [shipmentId])).rows[0];
  if (!s) throw Errors.notFound('Shipment');
  const inv = (await tx.query(`select i.*, p.legal_name from sales.invoices i join mdm.parties p on p.id = i.party_id where i.shipment_id = $1 and i.status = 'Posted'`, [shipmentId])).rows[0];
  if (!inv) return { problems: [{ field: 'docNo', message: 'The shipment has no posted invoice yet' }], payload: null, s, inv: null };
  const to = (await tx.query(`select line1, line2, city, state_code, pincode from mdm.party_addresses where id = $1`, [inv.ship_to_id])).rows[0];
  const bill = (await tx.query(`select state_code from mdm.party_addresses where id = $1`, [inv.bill_to_id])).rows[0];
  const sel = await seller(tx, inv.seller_gstin);
  const uqc = await getSetting<string>(tx, 'gst.uqc.default', 'NOS');
  const lines = (await tx.query(`select line_no, description, hsn_code, qty, taxable, gst_rate from sales.invoice_lines where invoice_id = $1 order by line_no`, [inv.id])).rows;
  const km = distanceKm ?? s.distance_km ?? null;
  if (!km) problems.push({ field: 'transDistance', message: 'Give the distance in km' });
  if (!s.wh_pincode) problems.push({ field: 'fromPincode', message: 'The dispatching warehouse has no PIN code' });
  if (!s.wh_city) problems.push({ field: 'fromPlace', message: 'The dispatching warehouse has no city' });
  if (!s.vehicle_no) problems.push({ field: 'vehicleNo', message: 'The vehicle number is missing' });
  if (!inv.seller_gstin) problems.push({ field: 'fromGstin', message: 'The invoice has no seller GSTIN' });
  const half = (rate: number) => (inv.inter_state ? 0 : rate / 2);
  const payload = { version: '1.0.0621', billLists: [{
    userGstin: inv.seller_gstin, supplyType: 'O', subSupplyType: 1, subSupplyDesc: '', docType: 'INV', docNo: inv.doc_no, docDate: dmy(inv.invoice_date),
    fromGstin: inv.seller_gstin, fromTrdName: sel?.trade_name ?? sel?.legal_name ?? '', fromAddr1: String(s.wh_address ?? '').slice(0, 120), fromAddr2: '', fromPlace: s.wh_city ?? '',
    fromPincode: Number(s.wh_pincode ?? 0), fromStateCode: Number(inv.seller_state), actualFromStateCode: Number(s.wh_state ?? inv.seller_state),
    toGstin: inv.party_gstin ?? 'URP', toTrdName: inv.legal_name, toAddr1: [to?.line1, to?.line2].filter(Boolean).join(', ').slice(0, 120), toAddr2: '', toPlace: to?.city ?? '',
    toPincode: Number(to?.pincode ?? 0), toStateCode: Number(bill?.state_code ?? inv.place_of_supply), actualToStateCode: Number(to?.state_code ?? inv.place_of_supply),
    transactionType: inv.bill_to_id === inv.ship_to_id ? 1 : 2, totalValue: num(inv.taxable_total), cgstValue: num(inv.cgst_total), sgstValue: num(inv.sgst_total), igstValue: num(inv.igst_total),
    cessValue: 0, cessNonAdvolValue: 0, otherValue: num(inv.round_off), totInvValue: num(inv.grand_total),
    transMode: 1, transDistance: String(km ?? 0), transporterId: s.tr_gstin ?? '', transporterName: s.tr_name ?? '', transDocNo: s.lr_no ?? '', transDocDate: s.lr_date ? dmy(s.lr_date) : '',
    vehicleNo: s.vehicle_no ?? '', vehicleType: 'R',
    itemList: lines.map((l, i) => ({ itemNo: i + 1, productName: String(l.description).slice(0, 100), productDesc: String(l.description).slice(0, 100), hsnCode: Number(l.hsn_code),
      quantity: num(l.qty), qtyUnit: uqc, taxableAmount: num(l.taxable), sgstRate: half(num(l.gst_rate)), cgstRate: half(num(l.gst_rate)), igstRate: inv.inter_state ? num(l.gst_rate) : 0, cessRate: 0, cessNonadvol: 0 })),
  }] };
  return { problems, payload, s, inv };
}

/** Rule 138(10): one day per kmPerDay (or part); each day ends at midnight following the date of generation (IST). */
export function ewbValidUntil(generated: Date, km: number, kmPerDay: number) {
  const days = Math.max(1, Math.ceil(km / kmPerDay));
  const ist = new Date(generated.getTime() + 5.5 * 3_600_000);
  const end = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + days, 23, 59, 59) - 5.5 * 3_600_000;
  return new Date(end);
}

// ================================================================ returns
async function gstinsInScope(dbx: Db | Tx, req: Request, perm: string) {
  const scope = legalEntityScope(req, perm);
  return (await dbx.query(`select g.gstin, g.state_code as "stateCode", g.legal_entity_id as "legalEntityId", le.name as "legalEntityName" from org.gst_registrations g
      join org.legal_entities le on le.id = g.legal_entity_id where g.status = 'Active' and ($1::uuid[] is null or g.legal_entity_id = any($1::uuid[])) order by g.gstin`, [scope])).rows;
}

const itm = (rows: { rt: number; txval: number; iamt: number; camt: number; samt: number }[]) =>
  rows.map((x, i) => ({ num: i + 1, itm_det: { rt: x.rt, txval: r2(x.txval), iamt: r2(x.iamt), camt: r2(x.camt), samt: r2(x.samt), csamt: 0 } }));

export async function buildGstr1(dbx: Db | Tx, gstin: string, period: string) {
  const [y, m] = period.split('-');
  const from = `${period}-01`;
  const to = new Date(Date.UTC(Number(y), Number(m), 0)).toISOString().slice(0, 10);
  const b2clLimit = Number(await getSetting(dbx, 'gst.gstr1.b2clThreshold', 100000));
  const uqc = await getSetting<string>(dbx, 'gst.uqc.default', 'NOS');
  const invs = (await dbx.query(`select i.id, i.doc_no, i.invoice_date, i.party_gstin, i.place_of_supply, i.inter_state, i.grand_total, i.status from sales.invoices i
      where i.seller_gstin = $1 and i.invoice_date between $2 and $3 order by i.doc_no`, [gstin, from, to])).rows;
  const posted = invs.filter((x) => x.status === 'Posted');
  const rates = posted.length ? (await dbx.query(`select invoice_id, gst_rate::float as rt, sum(taxable)::float as txval, sum(igst)::float as iamt, sum(cgst)::float as camt, sum(sgst)::float as samt
      from sales.invoice_lines where invoice_id = any($1::uuid[]) group by 1, 2 order by 2`, [posted.map((x) => x.id)])).rows : [];
  const byInv = (id: string) => rates.filter((x) => x.invoice_id === id);
  const b2b: Record<string, unknown[]> = {}; const b2cl: Record<string, unknown[]> = {}; const b2cs = new Map<string, { sply_ty: string; pos: string; typ: string; rt: number; txval: number; iamt: number; camt: number; samt: number; csamt: number }>();
  const addB2cs = (inter: boolean, pos: string, x: { rt: number; txval: number; iamt: number; camt: number; samt: number }, sign = 1) => {
    const k = `${inter}|${pos}|${x.rt}`;
    const t = b2cs.get(k) ?? { sply_ty: inter ? 'INTER' : 'INTRA', pos, typ: 'OE', rt: x.rt, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
    t.txval += sign * x.txval; t.iamt += sign * x.iamt; t.camt += sign * x.camt; t.samt += sign * x.samt; b2cs.set(k, t);
  };
  for (const i of posted) {
    const inv = { inum: i.doc_no, idt: dmy(i.invoice_date, '-'), val: num(i.grand_total), pos: i.place_of_supply, rchrg: 'N', inv_typ: 'R', itms: itm(byInv(i.id)) };
    if (i.party_gstin) (b2b[i.party_gstin] ??= []).push(inv);
    else if (i.inter_state && num(i.grand_total) > b2clLimit) (b2cl[i.place_of_supply] ??= []).push({ inum: inv.inum, idt: inv.idt, val: inv.val, itms: inv.itms });
    else for (const x of byInv(i.id)) addB2cs(i.inter_state, i.place_of_supply, x);
  }
  const cns = (await dbx.query(`select c.id, c.doc_no, c.note_date, c.grand_total, i.party_gstin, i.place_of_supply, i.inter_state from sales.credit_notes c join sales.invoices i on i.id = c.invoice_id
      where i.seller_gstin = $1 and c.status = 'Approved' and c.note_date between $2 and $3 order by c.doc_no`, [gstin, from, to])).rows;
  const cnRates = cns.length ? (await dbx.query(`select credit_note_id, gst_rate::float as rt, sum(taxable)::float as txval, sum(igst)::float as iamt, sum(cgst)::float as camt, sum(sgst)::float as samt
      from sales.credit_note_lines where credit_note_id = any($1::uuid[]) group by 1, 2 order by 2`, [cns.map((x) => x.id)])).rows : [];
  const cdnr: Record<string, unknown[]> = {};
  for (const c of cns) {
    const rs = cnRates.filter((x) => x.credit_note_id === c.id);
    if (c.party_gstin) (cdnr[c.party_gstin] ??= []).push({ ntty: 'C', nt_num: c.doc_no, nt_dt: dmy(c.note_date, '-'), val: num(c.grand_total), pos: c.place_of_supply, rchrg: 'N', inv_typ: 'R', itms: itm(rs) });
    else for (const x of rs) addB2cs(c.inter_state, c.place_of_supply, x, -1);    // unregistered small-value notes reduce B2CS
  }
  const hsn = (await dbx.query(`select hsn_code, rt, max(description) as descr, sum(qty)::float as qty, sum(txval)::float as txval, sum(iamt)::float as iamt, sum(camt)::float as camt, sum(samt)::float as samt from (
        select l.hsn_code, l.gst_rate::float as rt, l.description, l.qty, l.taxable as txval, l.igst as iamt, l.cgst as camt, l.sgst as samt from sales.invoice_lines l join sales.invoices i on i.id = l.invoice_id
         where i.seller_gstin = $1 and i.status = 'Posted' and i.invoice_date between $2 and $3
        union all
        select il.hsn_code, cl.gst_rate::float, il.description, -coalesce(cl.qty, 0), -cl.taxable, -cl.igst, -cl.cgst, -cl.sgst from sales.credit_note_lines cl join sales.credit_notes c on c.id = cl.credit_note_id
          join sales.invoice_lines il on il.id = cl.invoice_line_id join sales.invoices i on i.id = c.invoice_id where i.seller_gstin = $1 and c.status = 'Approved' and c.note_date between $2 and $3
      ) x group by 1, 2 order by 1, 2`, [gstin, from, to])).rows;
  const series = (docs: { doc_no: string; status?: string }[], docNum: number) => {
    if (!docs.length) return null;
    const sorted = [...docs].sort((a, b) => a.doc_no.localeCompare(b.doc_no));
    const cancel = docs.filter((d) => d.status === 'Cancelled').length;
    return { doc_num: docNum, docs: [{ num: 1, from: sorted[0]!.doc_no, to: sorted[sorted.length - 1]!.doc_no, totnum: docs.length, cancel, net_issue: docs.length - cancel }] };
  };
  const docDet = [series(invs, 1), series(cns.map((c) => ({ doc_no: c.doc_no })), 5)].filter(Boolean);
  const payload = {
    gstin, fp: `${m}${y}`,
    b2b: Object.entries(b2b).map(([ctin, inv]) => ({ ctin, inv })),
    b2cl: Object.entries(b2cl).map(([pos, inv]) => ({ pos, inv })),
    b2cs: [...b2cs.values()].filter((x) => Math.abs(x.txval) > 0.004).map((x) => ({ ...x, txval: r2(x.txval), iamt: r2(x.iamt), camt: r2(x.camt), samt: r2(x.samt) })),
    cdnr: Object.entries(cdnr).map(([ctin, nt]) => ({ ctin, nt })),
    hsn: { data: hsn.map((x, i) => ({ num: i + 1, hsn_sc: x.hsn_code, desc: String(x.descr).slice(0, 30), uqc, qty: r2(x.qty), rt: x.rt, txval: r2(x.txval), iamt: r2(x.iamt), camt: r2(x.camt), samt: r2(x.samt), csamt: 0 })) },
    doc_issue: { doc_det: docDet },
  };
  const tx = (k: 'txval' | 'iamt' | 'camt' | 'samt') => r2(rates.reduce((a, x) => a + x[k], 0) - cnRates.reduce((a, x) => a + x[k], 0));
  const summary = { invoices: posted.length, cancelled: invs.length - posted.length, creditNotes: cns.length, b2b: Object.values(b2b).flat().length, b2cl: Object.values(b2cl).flat().length,
    b2csRows: payload.b2cs.length, hsnRows: payload.hsn.data.length, taxable: tx('txval'), igst: tx('iamt'), cgst: tx('camt'), sgst: tx('samt') };
  return { payload, summary, from, to };
}

export async function buildGstr3b(db: Db, gstin: string, period: string) {
  const g1 = await buildGstr1(db, gstin, period);
  const le = (await db.query(`select legal_entity_id from org.gst_registrations where gstin = $1`, [gstin])).rows[0]?.legal_entity_id;
  const others = Number((await db.query(`select count(*) from org.gst_registrations where legal_entity_id = $1 and status = 'Active'`, [le])).rows[0].count) - 1;
  await syncLedger(db);
  const mv = (await db.query(`select a.system_key as k, coalesce(sum(l.debit - l.credit), 0)::float as dr from fin.accounts a join fin.journal_lines l on l.account_id = a.id join fin.journals j on j.id = l.journal_id
      where j.legal_entity_id = $1 and j.status in ('Posted','Reversed') and j.journal_date between $2 and $3 and a.system_key in ('INPUT_CGST','INPUT_SGST','INPUT_IGST','INPUT_GST_RCM','INPUT_GST_OTHER','RCM_PAYABLE')
      group by 1`, [le, g1.from, g1.to])).rows;
  const v = (k: string) => r2(mv.find((x) => x.k === k)?.dr ?? 0);
  const rcm = r2(-v('RCM_PAYABLE'));
  const payload = {
    gstin, ret_period: `${period.slice(5)}${period.slice(0, 4)}`,
    sup_details: {
      osup_det: { txval: g1.summary.taxable, iamt: g1.summary.igst, camt: g1.summary.cgst, samt: g1.summary.sgst, csamt: 0 },
      osup_zero: { txval: 0, iamt: 0, csamt: 0 }, osup_nil_exmp: { txval: 0 },
      isup_rev: { txval: 0, iamt: 0, camt: r2(rcm / 2), samt: r2(rcm - r2(rcm / 2)), csamt: 0 }, osup_nongst: { txval: 0 },
    },
    itc_elg: {
      itc_avl: [
        { ty: 'IMPG', iamt: 0, camt: 0, samt: 0, csamt: 0 }, { ty: 'IMPS', iamt: 0, camt: 0, samt: 0, csamt: 0 },
        { ty: 'ISRC', iamt: 0, camt: r2(v('INPUT_GST_RCM') / 2), samt: r2(v('INPUT_GST_RCM') - r2(v('INPUT_GST_RCM') / 2)), csamt: 0 },
        { ty: 'ISD', iamt: 0, camt: 0, samt: 0, csamt: 0 },
        { ty: 'OTH', iamt: v('INPUT_IGST'), camt: r2(v('INPUT_CGST') + v('INPUT_GST_OTHER') / 2), samt: r2(v('INPUT_SGST') + v('INPUT_GST_OTHER') - v('INPUT_GST_OTHER') / 2), csamt: 0 },
      ],
      itc_rev: [{ ty: 'RUL', iamt: 0, camt: 0, samt: 0, csamt: 0 }, { ty: 'OTH', iamt: 0, camt: 0, samt: 0, csamt: 0 }],
    },
  };
  const itc = payload.itc_elg.itc_avl.reduce((a, x) => a + x.iamt + x.camt + x.samt, 0);
  const out = g1.summary.igst + g1.summary.cgst + g1.summary.sgst + rcm;
  return { payload, summary: { outwardTaxable: g1.summary.taxable, outputTax: r2(out), itc: r2(itc), netPayable: r2(out - itc),
    note: others > 0 ? 'Input tax credit comes from the ledger of the whole legal entity, which has more than one GSTIN: split it by GSTIN before filing.' : null } };
}

// ================================================================ routes
export function gstIntegrationRoutes(db: Db) {
  const r = Router();
  const sha = (o: unknown) => createHash('sha256').update(JSON.stringify(o)).digest('hex');
  const inScope = (req: Request, perm: string, le: string) => { const s = legalEntityScope(req, perm); return !s || s.includes(le); };
  const kindOf = (v: string | undefined): 'INV' | 'CRN' => { if (v === 'invoice') return 'INV'; if (v === 'credit-note') return 'CRN'; throw Errors.notFound(); };

  // ---- e-invoice
  r.get('/einvoice/:kind/:id', requirePermission('sales.invoice:view'), asyncHandler(async (req, res) => {
    const kind = kindOf(req.params.kind);
    const x = await einvoicePayload(db, kind, req.params.id!);
    if (!inScope(req, 'sales.invoice:view', x.inv.legal_entity_id)) throw Errors.notFound();
    const i = await getIntegration(db, 'EINVOICE');
    const history = await einvoiceRow(db, kind, req.params.id!);
    const active = history.find((h) => h.status === 'Generated');
    const allowed: string[] = [];
    if (i.mode !== 'OFF' && x.applicable && !active && !x.problems.length && can(req, 'gst.einvoice:generate')) allowed.push(i.mode === 'MANUAL' ? 'record' : 'generate');
    if (active && can(req, 'gst.einvoice:cancel') && Date.now() - new Date(active.ackDate).getTime() < 24 * 3_600_000) allowed.push('cancel');
    res.json({ mode: i.mode, applicable: x.applicable, reason: x.reason, problems: x.problems, payload: x.payload, active: active ? await einvoiceForPrint(db, kind, req.params.id!) : null,
      history, allowedActions: allowed, cancelReasons: REASONS });
  }));

  r.post('/einvoice/:kind/:id', requirePermission('gst.einvoice:generate'), asyncHandler(async (req, res) => {
    const kind = kindOf(req.params.kind);
    const manual = z.object({ irn: z.string().trim().toLowerCase().regex(/^[0-9a-f]{64}$/, 'The IRN has 64 hexadecimal characters'), ackNo: z.string().trim().regex(/^[0-9]{10,20}$/, 'Acknowledgement number'),
      ackDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/)), signedQr: z.string().trim().min(20).max(4000) });
    const out = await withTx(db, async (tx) => {
      const i = await requireOn(tx, 'EINVOICE');
      const x = await einvoicePayload(tx, kind, req.params.id!);
      if (!inScope(req, 'gst.einvoice:generate', x.inv.legal_entity_id)) throw Errors.notFound();
      if (!x.applicable) throw Errors.rule('EINVOICE_NOT_APPLICABLE', x.reason!);
      if (x.problems.length) throw Errors.rule('EINVOICE_INCOMPLETE', 'Correct the master data first.', x.problems);
      await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`einv:${req.params.id}`]);
      if ((await einvoiceRow(tx, kind, req.params.id!)).some((h) => h.status === 'Generated')) throw Errors.conflict('IRN_EXISTS', 'An IRN is already recorded for this document.');
      const year = fy(kind === 'INV' ? x.inv.invoice_date : x.doc.note_date);
      let reply: { irn: string; ackNo: string; ackDate: Date; signedQr: string };
      if (i.mode === 'SIMULATED') reply = simulateIrp(x.payload!, year);
      else {
        const m = parse(manual, req.body);
        // the IRN is fixed by GSTIN, year, type and number: a typo is caught here
        const expected = irnOf(x.payload!.SellerDtls.Gstin, year, kind, x.payload!.DocDtls.No);
        if (m.irn !== expected) throw Errors.rule('IRN_MISMATCH', 'This IRN does not belong to this document (it is computed from the GSTIN, year, type and number). Check that the right document was uploaded.');
        reply = { irn: m.irn, ackNo: m.ackNo, ackDate: new Date(m.ackDate.includes('T') || m.ackDate.includes('+') ? m.ackDate : `${m.ackDate.replace(' ', 'T')}+05:30`), signedQr: m.signedQr };
      }
      if ((await tx.query(`select 1 from gst.einvoices where irn = $1`, [reply.irn])).rowCount) {
        throw Errors.rule('DOC_NO_USED', 'The IRP does not accept a document number again once its IRN was cancelled. Cancel this document and raise a new one.');
      }
      const row = (await tx.query(`insert into gst.einvoices (doc_kind, invoice_id, credit_note_id, legal_entity_id, seller_gstin, doc_no, mode, irn, ack_no, ack_date, signed_qr, payload, created_by)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
        [kind, kind === 'INV' ? req.params.id : null, kind === 'CRN' ? req.params.id : null, x.inv.legal_entity_id, x.inv.seller_gstin, x.doc.doc_no, i.mode, reply.irn, reply.ackNo, reply.ackDate, reply.signedQr,
          JSON.stringify(x.payload), req.auth!.user.id])).rows[0];
      if (kind === 'INV') await tx.query(`update sales.invoices set irn = $2 where id = $1`, [req.params.id, reply.irn]);
      await logCall(tx, { integration: 'EINVOICE', operation: 'generate', mode: i.mode, subjectType: kind === 'INV' ? 'sales.invoice' : 'sales.credit_note', subjectId: req.params.id, ok: true, request: x.payload, response: { irn: reply.irn, ackNo: reply.ackNo }, userId: req.auth!.user.id });
      await audit(tx, actorOf(req), { action: 'gst.einvoice.generated', entityType: kind === 'INV' ? 'sales.invoice' : 'sales.credit_note', entityId: req.params.id!, after: { irn: reply.irn, ackNo: reply.ackNo, mode: i.mode } });
      return { id: row.id as string, irn: reply.irn, ackNo: reply.ackNo, mode: i.mode };
    });
    res.status(201).json(out);
  }));

  r.post('/einvoice/:kind/:id/cancel', requirePermission('gst.einvoice:cancel'), asyncHandler(async (req, res) => {
    const kind = kindOf(req.params.kind);
    const d = parse(z.object({ reason: z.enum(['1', '2', '3', '4']), remarks: text(100) }), req.body);
    await withTx(db, async (tx) => {
      const i = await requireOn(tx, 'EINVOICE');
      const e = (await tx.query(`select * from gst.einvoices where ${kind === 'INV' ? 'invoice_id' : 'credit_note_id'} = $1 and status = 'Generated' for update`, [req.params.id])).rows[0];
      if (!e || !inScope(req, 'gst.einvoice:cancel', e.legal_entity_id)) throw Errors.notFound('E-invoice');
      if (Date.now() - new Date(e.ack_date).getTime() >= 24 * 3_600_000) throw Errors.rule('IRN_CANCEL_WINDOW_OVER', 'An IRN can be cancelled only within 24 hours of its acknowledgement; issue a credit note instead.');
      await tx.query(`update gst.einvoices set status = 'Cancelled', cancel_reason = $2, cancel_remarks = $3, cancelled_at = now() where id = $1`, [e.id, d.reason, d.remarks]);
      if (kind === 'INV') await tx.query(`update sales.invoices set irn = null where id = $1`, [req.params.id]);
      await logCall(tx, { integration: 'EINVOICE', operation: 'cancel', mode: i.mode, subjectType: kind === 'INV' ? 'sales.invoice' : 'sales.credit_note', subjectId: req.params.id, ok: true, request: { Irn: e.irn, CnlRsn: d.reason, CnlRem: d.remarks }, userId: req.auth!.user.id });
      await audit(tx, actorOf(req), { action: 'gst.einvoice.cancelled', entityType: kind === 'INV' ? 'sales.invoice' : 'sales.credit_note', entityId: req.params.id!, after: { irn: e.irn, ...d } });
    });
    res.json({ ok: true });
  }));

  // ---- e-way bill
  r.get('/ewaybill/:shipmentId', requirePermission('logistics.shipment:view'), asyncHandler(async (req, res) => {
    const km = Number(req.query.distanceKm) || null;
    const x = await ewbPayload(db, req.params.shipmentId!, km);
    if (!inScope(req, 'logistics.shipment:view', x.s.legal_entity_id)) throw Errors.notFound('Shipment');
    const i = await getIntegration(db, 'EWAYBILL');
    const threshold = Number(await getSetting(db, 'logistics.ewb.thresholdValue', 50000));
    const history = (await db.query(`select e.id, e.mode, e.status, e.ewb_no as "ewbNo", e.ewb_date as "ewbDate", e.valid_until as "validUntil", e.distance_km as "distanceKm", e.vehicle_no as "vehicleNo",
        e.cancel_reason as "cancelReason", e.cancelled_at as "cancelledAt", u.full_name as "createdBy" from gst.ewaybills e left join iam.users u on u.id = e.created_by where e.shipment_id = $1 order by e.created_at desc`, [req.params.shipmentId])).rows;
    const active = history.find((h) => h.status === 'Generated');
    const required = !!x.inv && Number(x.inv.grand_total) > threshold;
    const allowed: string[] = [];
    if (i.mode !== 'OFF' && x.inv && !active && ['Dispatched'].includes(x.s.status) && can(req, 'gst.ewaybill:generate')) allowed.push(i.mode === 'MANUAL' ? 'record' : 'generate');
    if (active && can(req, 'gst.ewaybill:generate') && Date.now() - new Date(active.ewbDate).getTime() < 24 * 3_600_000) allowed.push('cancel');
    res.json({ mode: i.mode, required, threshold, problems: x.problems, payload: x.payload, active: active ?? null, history, allowedActions: allowed, distanceKm: km ?? x.s.distance_km ?? null,
      kmPerDay: Number(await getSetting(db, 'logistics.ewb.kmPerDay', 200)) });
  }));

  r.post('/ewaybill/:shipmentId', requirePermission('gst.ewaybill:generate'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ distanceKm: z.number().int().min(1).max(4000), ewbNo: z.string().regex(/^[0-9]{12}$/, 'The e-way bill number has 12 digits').optional(),
      ewbDate: z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/).optional() }), req.body);
    const out = await withTx(db, async (tx) => {
      const i = await requireOn(tx, 'EWAYBILL');
      await tx.query(`select id from logistics.shipments where id = $1 for update`, [req.params.shipmentId]);
      const x = await ewbPayload(tx, req.params.shipmentId!, d.distanceKm);
      if (!inScope(req, 'gst.ewaybill:generate', x.s.legal_entity_id)) throw Errors.notFound('Shipment');
      if (x.s.status !== 'Dispatched') throw Errors.state('An e-way bill is made for a dispatched shipment that is on its way.');
      if (x.problems.length) throw Errors.rule('EWB_INCOMPLETE', 'Correct these first.', x.problems);
      if ((await tx.query(`select 1 from gst.ewaybills where shipment_id = $1 and status = 'Generated'`, [x.s.id])).rowCount) throw Errors.conflict('EWB_EXISTS', 'This shipment already has an e-way bill.');
      let ewbNo: string; let at: Date;
      if (i.mode === 'SIMULATED') { ewbNo = `${randomInt(1, 9)}${String(randomInt(0, 1e9)).padStart(9, '0')}${String(randomInt(0, 99)).padStart(2, '0')}`; at = new Date(); }
      else {
        if (!d.ewbNo || !d.ewbDate) throw Errors.validation([{ field: 'ewbNo', message: 'Enter the e-way bill number and the date and time shown on the portal' }]);
        ewbNo = d.ewbNo; at = new Date(d.ewbDate.length <= 16 || !/[+Z]/.test(d.ewbDate) ? `${d.ewbDate.replace(' ', 'T').slice(0, 16)}:00+05:30` : d.ewbDate);
        if (at.getTime() > Date.now() + 60_000) throw Errors.rule('INVALID_DATE', 'The e-way bill date cannot be in the future.');
      }
      const until = ewbValidUntil(at, d.distanceKm, Number(await getSetting(tx, 'logistics.ewb.kmPerDay', 200)));
      await tx.query(`insert into gst.ewaybills (shipment_id, invoice_id, mode, ewb_no, ewb_date, valid_until, distance_km, vehicle_no, transporter_gstin, payload, created_by)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [x.s.id, x.inv!.id, i.mode, ewbNo, at, until, d.distanceKm, x.s.vehicle_no, x.s.tr_gstin, JSON.stringify(x.payload), req.auth!.user.id]);
      await tx.query(`update logistics.shipments set ewb_no = $2, ewb_valid_until = ($3::timestamptz at time zone 'Asia/Kolkata')::date, distance_km = $4, updated_by = $5 where id = $1`,
        [x.s.id, ewbNo, until, d.distanceKm, req.auth!.user.id]);
      await logCall(tx, { integration: 'EWAYBILL', operation: 'generate', mode: i.mode, subjectType: 'logistics.shipment', subjectId: x.s.id, ok: true, request: x.payload, response: { ewbNo, validUntil: until }, userId: req.auth!.user.id });
      await audit(tx, actorOf(req), { action: 'gst.ewaybill.generated', entityType: 'logistics.shipment', entityId: x.s.id, after: { ewbNo, validUntil: until, distanceKm: d.distanceKm, mode: i.mode } });
      return { ewbNo, validUntil: until, mode: i.mode };
    });
    res.status(201).json(out);
  }));

  r.post('/ewaybill/:shipmentId/cancel', requirePermission('gst.ewaybill:generate'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ reason: z.enum(['1', '2', '3', '4']), remarks: text(100) }), req.body);
    await withTx(db, async (tx) => {
      const i = await requireOn(tx, 'EWAYBILL');
      const e = (await tx.query(`select e.*, s.legal_entity_id, s.status as shipment_status from gst.ewaybills e join logistics.shipments s on s.id = e.shipment_id where e.shipment_id = $1 and e.status = 'Generated' for update of e`, [req.params.shipmentId])).rows[0];
      if (!e || !inScope(req, 'gst.ewaybill:generate', e.legal_entity_id)) throw Errors.notFound('E-way bill');
      if (Date.now() - new Date(e.ewb_date).getTime() >= 24 * 3_600_000) throw Errors.rule('EWB_CANCEL_WINDOW_OVER', 'An e-way bill can be cancelled only within 24 hours of generation.');
      if (e.shipment_status === 'Delivered') throw Errors.rule('ALREADY_DELIVERED', 'The goods are delivered; the e-way bill cannot be cancelled.');
      await tx.query(`update gst.ewaybills set status = 'Cancelled', cancel_reason = $2, cancel_remarks = $3, cancelled_at = now() where id = $1`, [e.id, d.reason, d.remarks]);
      await tx.query(`update logistics.shipments set ewb_no = null, ewb_valid_until = null where id = $1`, [req.params.shipmentId]);
      await logCall(tx, { integration: 'EWAYBILL', operation: 'cancel', mode: i.mode, subjectType: 'logistics.shipment', subjectId: req.params.shipmentId, ok: true, request: { ewbNo: e.ewb_no, cancelRsnCode: d.reason, cancelRmrk: d.remarks }, userId: req.auth!.user.id });
      await audit(tx, actorOf(req), { action: 'gst.ewaybill.cancelled', entityType: 'logistics.shipment', entityId: req.params.shipmentId!, after: { ewbNo: e.ewb_no, ...d } });
    });
    res.json({ ok: true });
  }));

  // ---- returns
  const RET = 'gst.return:prepare';
  r.get('/returns', requirePermission(RET), asyncHandler(async (req, res) => {
    const gstins = await gstinsInScope(db, req, RET);
    const filings = (await db.query(`select f.id, f.gstin, f.return_type as "returnType", f.period, f.status, f.summary, f.arn, f.filed_on as "filedOn", f.prepared_at as "preparedAt", pu.full_name as "preparedBy",
        f.filed_at as "filedAt", fu.full_name as "filedBy" from gst.return_filings f left join iam.users pu on pu.id = f.prepared_by left join iam.users fu on fu.id = f.filed_by
        where f.gstin = any($1::text[]) order by f.period desc, f.return_type, f.prepared_at desc limit 200`, [gstins.map((g) => g.gstin)])).rows;
    res.json({ gstins, data: filings, mode: (await getIntegration(db, 'GST_RETURNS')).mode, canFile: can(req, 'gst.return:file') });
  }));

  const retQ = (req: Request) => {
    const gstin = str(req.query.gstin) ?? (req.body?.gstin as string | undefined);
    const period = str(req.query.period) ?? (req.body?.period as string | undefined);
    const type = (str(req.query.type) ?? (req.body?.type as string | undefined)) as 'GSTR1' | 'GSTR3B' | undefined;
    if (!gstin || !period || !/^\d{4}-\d{2}$/.test(period) || !type || !['GSTR1', 'GSTR3B'].includes(type)) throw Errors.validation([{ field: 'period', message: 'Give gstin, period (YYYY-MM) and type GSTR1 or GSTR3B' }]);
    return { gstin, period, type };
  };
  const build = (q: { gstin: string; period: string; type: 'GSTR1' | 'GSTR3B' }) => (q.type === 'GSTR1' ? buildGstr1(db, q.gstin, q.period) : buildGstr3b(db, q.gstin, q.period));

  r.get('/returns/preview', requirePermission(RET), asyncHandler(async (req, res) => {
    const q = retQ(req);
    if (!(await gstinsInScope(db, req, RET)).some((g) => g.gstin === q.gstin)) throw Errors.notFound('GSTIN');
    const b = await build(q);
    const filed = (await db.query(`select arn, filed_on as "filedOn" from gst.return_filings where gstin = $1 and return_type = $2 and period = $3 and status = 'Filed'`, [q.gstin, q.type, q.period])).rows[0] ?? null;
    res.json({ ...q, payload: b.payload, summary: b.summary, filed });
  }));

  r.post('/returns', requirePermission(RET), asyncHandler(async (req, res) => {
    const q = retQ(req);
    const out = await withTx(db, async (tx) => {
      await requireOn(tx, 'GST_RETURNS');
      const g = (await gstinsInScope(tx, req, RET)).find((x) => x.gstin === q.gstin);
      if (!g) throw Errors.notFound('GSTIN');
      if ((await tx.query(`select 1 from gst.return_filings where gstin = $1 and return_type = $2 and period = $3 and status = 'Filed'`, [q.gstin, q.type, q.period])).rowCount) throw Errors.conflict('RETURN_FILED', 'This return is already filed.');
      if (q.period > todayIST().slice(0, 7)) throw Errors.rule('PERIOD_NOT_STARTED', 'That month has not started.');
      const b = await build(q);
      const row = (await tx.query(`insert into gst.return_filings (gstin, legal_entity_id, return_type, period, payload, payload_sha256, summary, prepared_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [q.gstin, g.legalEntityId, q.type, q.period, JSON.stringify(b.payload), sha(b.payload), JSON.stringify(b.summary), req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: 'gst.return.prepared', entityType: 'gst.return_filing', entityId: row.id, after: { ...q, summary: b.summary } });
      return { id: row.id as string, summary: b.summary };
    });
    res.status(201).json(out);
  }));

  r.get('/returns/:id/json', requirePermission(RET), asyncHandler(async (req, res) => {
    const f = (await db.query(`select * from gst.return_filings where id = $1`, [req.params.id])).rows[0];
    if (!f || !(await gstinsInScope(db, req, RET)).some((g) => g.gstin === f.gstin)) throw Errors.notFound('Return');
    res.setHeader('content-type', 'application/json');
    res.setHeader('content-disposition', `attachment; filename="${f.return_type}_${f.gstin}_${f.period.replace('-', '')}.json"`);
    res.send(JSON.stringify(f.payload));
  }));

  r.post('/returns/:id/filed', requirePermission('gst.return:file'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ arn: z.string().trim().toUpperCase().regex(/^[A-Z]{2}[0-9A-Z]{13}$/, 'The ARN has 15 characters, e.g. AA2711240123456'), filedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.body);
    await withTx(db, async (tx) => {
      const f = (await tx.query(`select * from gst.return_filings where id = $1 for update`, [req.params.id])).rows[0];
      if (!f || !(await gstinsInScope(tx, req, 'gst.return:file')).some((g) => g.gstin === f.gstin)) throw Errors.notFound('Return');
      if (f.status !== 'Prepared') throw Errors.state('This return is already filed.');
      // the file uploaded must be the latest one: anything posted since preparation would be missing from the return
      const now = await (f.return_type === 'GSTR1' ? buildGstr1(tx, f.gstin, f.period) : buildGstr3b(db, f.gstin, f.period));
      if (sha(now.payload) !== f.payload_sha256) throw Errors.rule('RETURN_STALE', 'Documents changed after this return was prepared. Prepare it again and upload the new file.');
      if (d.filedOn < `${f.period}-01`) throw Errors.rule('INVALID_DATE', 'A return is filed after its month begins.');
      await tx.query(`update gst.return_filings set status = 'Filed', arn = $2, filed_on = $3, filed_at = now(), filed_by = $4 where id = $1`, [f.id, d.arn, d.filedOn, req.auth!.user.id]);
      await logCall(tx, { integration: 'GST_RETURNS', operation: `file ${f.return_type}`, mode: 'MANUAL', subjectType: 'gst.return_filing', subjectId: f.id, ok: true, response: d, userId: req.auth!.user.id });
      await audit(tx, actorOf(req), { action: 'gst.return.filed', entityType: 'gst.return_filing', entityId: f.id, after: { type: f.return_type, gstin: f.gstin, period: f.period, ...d } });
    });
    res.json({ ok: true });
  }));
  return r;
}

export type { Integration };
