import { afterAll, describe, expect, it } from 'vitest';
import { irnOf, ewbValidUntil } from '../src/modules/integrations/gst';
import { todayIST } from '../src/modules/sales/quotations';
import { db, uniq, userAgent } from './helpers';
import { dispatched } from './dispatch-fixtures';

const setMode = (code: string, mode: string) => db.query(`update sys.integrations set mode = $2 where code = $1`, [code, mode]);
const fyOf = (d: string) => { const y = Number(d.slice(0, 4)); const s = Number(d.slice(5, 7)) >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };
const gstinFor = () => `27${'ABCDE'}${String(Math.floor(Math.random() * 9000) + 1000)}F1Z${Math.floor(Math.random() * 9)}`;

/** Makes the fixture's dealer GST-registered and fills the addresses the GST schemas need. */
async function registered() {
  const x = await dispatched();
  const ctin = gstinFor();
  await db.query(`update mdm.parties set gstin = $2, gst_registered = true where id = $1`, [x.party, ctin]);
  await db.query(`update sales.invoices set party_gstin = $2 where id = $1`, [x.invoice.id, ctin]);
  const inv = (await db.query(`select seller_gstin, legal_entity_id from sales.invoices where id = $1`, [x.invoice.id])).rows[0];
  let sellerGstin = inv.seller_gstin as string | null;
  if (!sellerGstin) {
    sellerGstin = (await db.query(`select gstin from org.gst_registrations where legal_entity_id = $1 and state_code = '27'`, [inv.legal_entity_id])).rows[0]?.gstin
      ?? (await db.query(`insert into org.gst_registrations (legal_entity_id, state_code, gstin) values ($1,'27',$2) returning gstin`, [inv.legal_entity_id, gstinFor()])).rows[0].gstin;
    await db.query(`update sales.invoices set seller_gstin = $2 where id = $1`, [x.invoice.id, sellerGstin]);
  }
  return { ...x, ctin, sellerGstin: sellerGstin!, le: inv.legal_entity_id as string };
}

describe('GST integrations: e-invoice, e-way bill, GSTR-1/3B (FIN-019, LOG-005)', () => {
  afterAll(async () => { for (const c of ['EINVOICE', 'EWAYBILL', 'GST_RETURNS']) await setMode(c, 'OFF'); });

  it('records an IRN from the portal, prints it, and blocks invoice cancellation until the IRN is cancelled', async () => {
    const x = await registered();
    const admin = await userAgent([{ code: 'EXEC_ADMIN' }]);
    await x.fh.post(`/api/v1/gst/einvoice/invoice/${x.invoice.id}`, {}).expect(422).expect((r) => expect(r.body.error.code).toBe('INTEGRATION_OFF'));
    // GST LIVE needs the provider (D27); manual works now; secrets never go in the config
    expect((await admin.put('/api/v1/integrations/EINVOICE', { mode: 'LIVE', provider: 'X' }).expect(422)).body.error.code).toBe('NO_LIVE_ADAPTER');
    expect((await admin.put('/api/v1/integrations/EMAIL', { mode: 'LIVE', provider: 'SMTP', config: { host: 'smtp.x', password: 'p' } }).expect(422)).body.error.code).toBe('UNKNOWN_SETTING');
    expect((await admin.put('/api/v1/integrations/SMS', { mode: 'LIVE', provider: 'WEBHOOK', config: { url: 'https://x', tokenEnv: 'SMS_TOKEN' } }).expect(200)).body.ok).toBe(true);
    await admin.put('/api/v1/integrations/SMS', { mode: 'OFF' }).expect(200);
    await admin.put('/api/v1/integrations/EINVOICE', { mode: 'MANUAL' }).expect(200);
    await x.accounts.put('/api/v1/integrations/EINVOICE', { mode: 'OFF' }).expect(403);

    let v = (await x.fh.get(`/api/v1/gst/einvoice/invoice/${x.invoice.id}`).expect(200)).body;
    expect(v.applicable).toBe(true);
    expect(v.problems.map((p: { field: string }) => p.field)).toEqual(expect.arrayContaining(['Seller.Addr1', 'Seller.Pin']));
    expect(v.allowedActions).toEqual([]);
    await db.query(`update org.gst_registrations set addr_line1 = '[TEST] Plot 4, MIDC', location = 'Chakan', pincode = '410501' where gstin = $1`, [x.sellerGstin]);
    v = (await x.fh.get(`/api/v1/gst/einvoice/invoice/${x.invoice.id}`).expect(200)).body;
    expect(v.problems).toEqual([]);
    expect(v.allowedActions).toEqual(['record']);
    expect(v.payload).toMatchObject({ Version: '1.1', DocDtls: { Typ: 'INV', No: x.invoice.docNo }, BuyerDtls: { Gstin: x.ctin, Pos: '27', Pin: 413102 },
      ValDtls: { AssVal: 4800, CgstVal: 120, SgstVal: 120, TotInvVal: 5040 } });
    expect(v.payload.ItemList[0]).toMatchObject({ HsnCd: '31059090', Qty: 24, Unit: 'NOS', UnitPrice: 200, AssAmt: 4800, GstRt: 5, TotItemVal: 5040 });

    const irn = irnOf(x.sellerGstin, fyOf(todayIST()), 'INV', x.invoice.docNo);
    const body = { irn: 'f'.repeat(64), ackNo: '112410012345678', ackDate: `${todayIST()} 10:15`, signedQr: 'eyJhbGciOiJSUzI1NiJ9.signed-qr-from-irp.sig' };
    expect((await x.fh.post(`/api/v1/gst/einvoice/invoice/${x.invoice.id}`, body).expect(422)).body.error.code).toBe('IRN_MISMATCH');
    await x.fh.post(`/api/v1/gst/einvoice/invoice/${x.invoice.id}`, { ...body, irn }).expect(201);
    await x.fh.post(`/api/v1/gst/einvoice/invoice/${x.invoice.id}`, { ...body, irn }).expect(409);
    const inv = (await x.fh.get(`/api/v1/sales-invoices/${x.invoice.id}`).expect(200)).body;
    expect(inv.irn).toBe(irn);
    expect(inv.einvoice).toMatchObject({ irn, ackNo: '112410012345678', simulated: false });
    expect(inv.einvoice.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    expect((await x.fh.post(`/api/v1/sales-invoices/${x.invoice.id}/cancel`, { reason: '[TEST] wrong rate' }).expect(422)).body.error.code).toBe('IRN_ACTIVE');
    await x.accounts.post(`/api/v1/gst/einvoice/invoice/${x.invoice.id}/cancel`, { reason: '2', remarks: 'Wrong rate' }).expect(403);
    await x.fh.post(`/api/v1/gst/einvoice/invoice/${x.invoice.id}/cancel`, { reason: '2', remarks: 'Wrong rate' }).expect(200);
    // the IRP will not take the same number again
    await setMode('EINVOICE', 'SIMULATED');
    expect((await x.fh.post(`/api/v1/gst/einvoice/invoice/${x.invoice.id}`, {}).expect(422)).body.error.code).toBe('DOC_NO_USED');
    await x.fh.post(`/api/v1/sales-invoices/${x.invoice.id}/cancel`, { reason: '[TEST] wrong rate' }).expect(200);
    const log = (await db.query(`select operation, ok from sys.integration_log where subject_id = $1 order by id`, [x.invoice.id])).rows;
    expect(log).toEqual([{ operation: 'generate', ok: true }, { operation: 'cancel', ok: true }]);
  });

  it('simulates an IRN, and generates an e-way bill after dispatch with validity from the distance', async () => {
    const x = await registered();
    await setMode('EINVOICE', 'SIMULATED');
    await db.query(`update org.gst_registrations set addr_line1 = '[TEST] Plot 4, MIDC', location = 'Chakan', pincode = '410501' where gstin = $1`, [x.sellerGstin]);
    const g = await x.accounts.post(`/api/v1/gst/einvoice/invoice/${x.invoice.id}`, {}).expect(201);
    expect(g.body).toMatchObject({ irn: irnOf(x.sellerGstin, fyOf(todayIST()), 'INV', x.invoice.docNo), mode: 'SIMULATED' });
    expect((await x.accounts.get(`/api/v1/sales-invoices/${x.invoice.id}`).expect(200)).body.einvoice.simulated).toBe(true);

    // validity: 450 km at 200 km a day = 3 days, ending at midnight IST
    const u = ewbValidUntil(new Date('2026-11-20T06:00:00Z'), 450, 200);
    expect(u.toISOString()).toBe('2026-11-23T18:29:59.000Z');
    expect(ewbValidUntil(new Date('2026-11-20T06:00:00Z'), 120, 200).toISOString()).toBe('2026-11-21T18:29:59.000Z');

    await db.query(`update sys.settings set value = '1000' where key = 'logistics.ewb.thresholdValue'`);
    try {
      await setMode('EWAYBILL', 'SIMULATED');
      const wh = (await db.query(`select warehouse_id from logistics.shipments where id = $1`, [x.shipmentId])).rows[0].warehouse_id;
      let e = (await x.logistics.get(`/api/v1/gst/ewaybill/${x.shipmentId}?distanceKm=450`).expect(200)).body;
      expect(e.required).toBe(true);
      expect(e.problems.map((p: { field: string }) => p.field)).toEqual(expect.arrayContaining(['fromPincode', 'fromPlace']));
      await db.query(`update org.warehouses set city = 'Chakan', pincode = '410501', address = '[TEST] FG godown, MIDC Chakan' where id = $1`, [wh]);
      e = (await x.logistics.get(`/api/v1/gst/ewaybill/${x.shipmentId}?distanceKm=450`).expect(200)).body;
      expect(e.problems).toEqual([]);
      expect(e.payload.billLists[0]).toMatchObject({ docNo: x.invoice.docNo, toGstin: x.ctin, fromPincode: 410501, toPincode: 413102, transDistance: '450', vehicleNo: 'MH12AB1234',
        totInvValue: 5040, transactionType: 1 });
      expect(e.payload.billLists[0].itemList[0]).toMatchObject({ hsnCode: 31059090, quantity: 24, cgstRate: 2.5, sgstRate: 2.5, igstRate: 0 });
      // closing the delivery needs the e-way bill once the integration is on
      const sh = (await x.logistics.get(`/api/v1/shipments/${x.shipmentId}`).expect(200)).body;
      const pod = { receivedOn: todayIST(), receivedBy: '[TEST] Owner', lines: sh.lines.map((l: { id: string; pickedPacks: number }) => ({ shipmentLineId: l.id, deliveredPacks: Number(l.pickedPacks) })) };
      expect((await x.logistics.post(`/api/v1/shipments/${x.shipmentId}/pod`, pod).expect(422)).body.error.code).toBe('EWB_MISSING');
      await x.accounts.post(`/api/v1/gst/ewaybill/${x.shipmentId}`, { distanceKm: 450 }).expect(403);
      const out = (await x.logistics.post(`/api/v1/gst/ewaybill/${x.shipmentId}`, { distanceKm: 450 }).expect(201)).body;
      expect(out.ewbNo).toMatch(/^[0-9]{12}$/);
      const row = (await db.query(`select ewb_no, ewb_valid_until::text as v, distance_km from logistics.shipments where id = $1`, [x.shipmentId])).rows[0];
      expect(row).toMatchObject({ ewb_no: out.ewbNo, distance_km: 450 });
      await x.logistics.post(`/api/v1/gst/ewaybill/${x.shipmentId}`, { distanceKm: 450 }).expect(409);
      await x.logistics.post(`/api/v1/gst/ewaybill/${x.shipmentId}/cancel`, { reason: '2', remarks: 'Vehicle changed' }).expect(200);
      expect((await db.query(`select ewb_no from logistics.shipments where id = $1`, [x.shipmentId])).rows[0].ewb_no).toBeNull();
      // manual: the number typed from the portal
      await setMode('EWAYBILL', 'MANUAL');
      await x.logistics.post(`/api/v1/gst/ewaybill/${x.shipmentId}`, { distanceKm: 450 }).expect(400);
      await x.logistics.post(`/api/v1/gst/ewaybill/${x.shipmentId}`, { distanceKm: 120, ewbNo: '341234567890', ewbDate: `${todayIST()} 09:30` }).expect(201);
      await x.logistics.post(`/api/v1/shipments/${x.shipmentId}/pod`, pod).expect(200);
    } finally {
      await db.query(`update sys.settings set value = '50000' where key = 'logistics.ewb.thresholdValue'`);
      await setMode('EWAYBILL', 'OFF');
    }
  });

  it('prepares GSTR-1 and GSTR-3B, refuses a stale file, records the ARN and closes the month', async () => {
    const x = await registered();
    const period = todayIST().slice(0, 7);
    await x.fh.post('/api/v1/gst/returns', { gstin: x.sellerGstin, period, type: 'GSTR1' }).expect(422);       // integration off
    await setMode('GST_RETURNS', 'MANUAL');
    const p = (await x.accounts.get(`/api/v1/gst/returns/preview?gstin=${x.sellerGstin}&period=${period}&type=GSTR1`).expect(200)).body;
    expect(p.payload.fp).toBe(`${period.slice(5)}${period.slice(0, 4)}`);
    const b2b = p.payload.b2b.find((b: { ctin: string }) => b.ctin === x.ctin);
    expect(b2b.inv[0]).toMatchObject({ inum: x.invoice.docNo, val: 5040, pos: '27', rchrg: 'N', itms: [{ num: 1, itm_det: { rt: 5, txval: 4800, camt: 120, samt: 120, iamt: 0 } }] });
    expect(p.payload.hsn.data.find((h: { hsn_sc: string }) => h.hsn_sc === '31059090')).toMatchObject({ uqc: 'NOS' });
    expect(p.payload.doc_issue.doc_det[0].doc_num).toBe(1);
    const g3 = (await x.accounts.get(`/api/v1/gst/returns/preview?gstin=${x.sellerGstin}&period=${period}&type=GSTR3B`).expect(200)).body;
    expect(g3.payload.sup_details.osup_det).toMatchObject({ txval: p.summary.taxable, camt: p.summary.cgst });

    const prep = (await x.accounts.post('/api/v1/gst/returns', { gstin: x.sellerGstin, period, type: 'GSTR1' }).expect(201)).body;
    const file = await x.accounts.get(`/api/v1/gst/returns/${prep.id}/json`).expect(200);
    expect(file.headers['content-disposition']).toContain(`GSTR1_${x.sellerGstin}`);
    await x.accounts.post(`/api/v1/gst/returns/${prep.id}/filed`, { arn: 'AA271124012345A', filedOn: todayIST() }).expect(403);
    // something changes after preparation: the uploaded file would be incomplete
    await db.query(`update sales.invoices set party_gstin = null where id = $1`, [x.invoice.id]);
    expect((await x.fh.post(`/api/v1/gst/returns/${prep.id}/filed`, { arn: 'AA271124012345A', filedOn: todayIST() }).expect(422)).body.error.code).toBe('RETURN_STALE');
    await db.query(`update sales.invoices set party_gstin = $2 where id = $1`, [x.invoice.id, x.ctin]);
    await x.fh.post(`/api/v1/gst/returns/${prep.id}/filed`, { arn: 'bad', filedOn: todayIST() }).expect(400);
    await x.fh.post(`/api/v1/gst/returns/${prep.id}/filed`, { arn: 'AA271124012345A', filedOn: todayIST() }).expect(200);
    await x.accounts.post('/api/v1/gst/returns', { gstin: x.sellerGstin, period, type: 'GSTR1' }).expect(409);
    expect((await x.fh.post(`/api/v1/sales-invoices/${x.invoice.id}/cancel`, { reason: '[TEST] late' }).expect(422)).body.error.code).toBe('RETURN_FILED');
    const list = (await x.accounts.get('/api/v1/gst/returns').expect(200)).body;
    expect(list.data.find((f: { id: string }) => f.id === prep.id)).toMatchObject({ status: 'Filed', arn: 'AA271124012345A' });
    expect(list.gstins.map((g: { gstin: string }) => g.gstin)).toContain(x.sellerGstin);
    void uniq;
  });
});
