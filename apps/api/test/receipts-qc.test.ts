import { describe, expect, it } from 'vitest';
import { db, userAgent, type Agent } from './helpers';
import { PDF, activeVendor, approve, approvedRequisition, inDays, setup, type F } from './purchase-fixtures';

/** An approved, issued PO for the raw material. */
async function issuedPo(f: F, vendor: string, qty: number, prLineId?: string) {
  const po = await f.pe.post('/api/v1/purchase-orders', { partyId: vendor, legalEntityId: f.le, warehouseId: f.wh, deliveryDate: inDays(10), paymentTermsDays: 30,
    deliveryTerms: 'Delivered', lines: [{ itemId: f.rm, qty, rate: 60, requisitionLineId: prLineId ?? null }] }).expect(201);
  const sub = await f.pe.post(`/api/v1/purchase-orders/${po.body.id}/submit`).expect(200);
  await approve(f.ph, sub.body.approvalRequestId).expect(200);
  if (qty * 60 * 1.18 > 100000) await approve(f.fh, sub.body.approvalRequestId).expect(200);
  await f.pe.post(`/api/v1/purchase-orders/${po.body.id}/issue`).expect(200);
  const lineId = (await db.query(`select id from purchase.purchase_order_lines where purchase_order_id = $1`, [po.body.id])).rows[0].id as string;
  return { id: po.body.id as string, lineId };
}
const grn = (poId: string, poLineId: string, qty: number, over: Record<string, unknown> = {}) => ({
  purchaseOrderId: poId, challanNo: `DC-${qty}`, lines: [{ poLineId, challanQty: qty, receivedQty: qty, vendorLotNo: 'ZN-2611-01', mfgDate: inDays(-10), ...over }],
});
const receive = async (f: F, poId: string, lineId: string, qty: number) => {
  const g = await f.keeper.post('/api/v1/goods-receipts', grn(poId, lineId, qty)).expect(201);
  const posted = await f.keeper.post(`/api/v1/goods-receipts/${g.body.id}/post`).expect(200);
  const d = (await f.keeper.get(`/api/v1/goods-receipts/${g.body.id}`).expect(200)).body;
  return { id: g.body.id as string, posted: posted.body, inspectionId: d.lines[0].inspectionId as string, lotId: d.lines[0].lotId as string };
};
const lotStock = async (lotId: string) => Object.fromEntries((await db.query(`select bucket, sum(qty)::float as q from inv.stock_ledger where lot_id = $1 group by bucket`, [lotId])).rows.map((r) => [r.bucket, r.q]));
const pass = [{ parameter: 'Zinc (Zn)', specification: '≥ 33.0%', result: '33.4%', pass: true }, { parameter: 'Moisture', specification: '≤ 1.0%', result: '0.6%', pass: true }];

async function qcUsers() {
  return { analyst: await userAgent([{ code: 'QC_ANALYST' }]), manager: await userAgent([{ code: 'QC_MANAGER' }]) };
}
async function coa(a: Agent, inspectionId: string) {
  return (await a.upload(`/api/v1/documents?documentType=COA&entityType=qc.inspection&entityId=${inspectionId}&title=CoA&fileName=coa.pdf`, PDF, 'application/pdf').expect(201)).body.id as string;
}

describe('Goods receipt into quarantine (PUR-008, TC-09)', () => {
  it('receives part of a PO into quarantine, enforces tolerance and lot details, then QC releases it', async () => {
    const f = await setup();
    const pr = await approvedRequisition(f);
    const vendor = await activeVendor(f, [f.rm]);
    const po = await issuedPo(f, vendor, 2500, pr.lineId);
    const open = (await f.keeper.get(`/api/v1/goods-receipts/open-po-lines?purchaseOrderId=${po.id}`).expect(200)).body;
    expect(open).toMatchObject({ tolerancePct: 2, data: [expect.objectContaining({ pendingQty: '2500.0000', lotControlled: true })] });

    expect((await f.keeper.post('/api/v1/goods-receipts', grn(po.id, po.lineId, 2551)).expect(422)).body.error.code).toBe('GRN_QTY_EXCEEDED');
    await f.keeper.post('/api/v1/goods-receipts', grn(po.id, po.lineId, 100, { vendorLotNo: null })).expect(400);
    expect((await f.keeper.post('/api/v1/goods-receipts', grn(po.id, po.lineId, 100, { mfgDate: '2024-01-01' })).expect(422)).body.error.code).toBe('EXPIRED_ON_RECEIPT');
    await f.sales.post('/api/v1/goods-receipts', grn(po.id, po.lineId, 100)).expect(403);

    const r1 = await receive(f, po.id, po.lineId, 1000);
    expect(r1.posted).toMatchObject({ poStatus: 'PartiallyReceived', lots: [expect.objectContaining({ qty: 1000 })] });
    expect(await lotStock(r1.lotId)).toEqual({ QUARANTINE: 1000 });
    const lot = (await f.keeper.get(`/api/v1/stock/lots/${r1.lotId}`).expect(200)).body;
    expect(lot).toMatchObject({ status: 'Quarantine', vendorLotNo: 'ZN-2611-01', expiryDate: inDays(355), poId: po.id });
    const bal = (await f.keeper.get('/api/v1/stock/balances').expect(200)).body.data.find((b: { itemId: string }) => b.itemId === f.rm);
    expect(bal).toMatchObject({ quarantine: '1000.0000', unrestricted: null });

    // QC: sample, test, decide — the analyst cannot decide, release needs passed tests and the vendor CoA
    const { analyst, manager } = await qcUsers();
    await f.keeper.post(`/api/v1/qc/inspections/${r1.inspectionId}/sample`, { sampleQty: 0.5 }).expect(403);
    await analyst.post(`/api/v1/qc/inspections/${r1.inspectionId}/sample`, { sampleQty: 0.5 }).expect(200);
    expect(await lotStock(r1.lotId)).toEqual({ QUARANTINE: 999.5 });
    const fail = [{ ...pass[0], result: '31.2%', pass: false }, pass[1]];
    expect((await analyst.post(`/api/v1/qc/inspections/${r1.inspectionId}/results`, { results: fail, coaReceived: false, recommendation: 'Release' }).expect(422)).body.error.code).toBe('RESULTS_FAILED');
    await analyst.post(`/api/v1/qc/inspections/${r1.inspectionId}/results`, { results: pass, coaReceived: false, recommendation: 'Release' }).expect(200);
    await analyst.post(`/api/v1/qc/inspections/${r1.inspectionId}/decide`, { decision: 'Release' }).expect(403);
    expect((await manager.post(`/api/v1/qc/inspections/${r1.inspectionId}/decide`, { decision: 'Release' }).expect(422)).body.error.code).toBe('COA_REQUIRED');
    const coaId = await coa(analyst, r1.inspectionId);
    await analyst.post(`/api/v1/qc/inspections/${r1.inspectionId}/results`, { results: pass, coaReceived: true, coaDocumentId: coaId, recommendation: 'Release' }).expect(200);
    const dec = await manager.post(`/api/v1/qc/inspections/${r1.inspectionId}/decide`, { decision: 'Release' }).expect(200);
    expect(dec.body).toEqual({ lotStatus: 'Released', vendorRating: 5 });
    expect(await lotStock(r1.lotId)).toEqual({ QUARANTINE: 0, UNRESTRICTED: 999.5 });
    expect((await analyst.get(`/api/v1/qc/inspections/${r1.inspectionId}`).expect(200)).body).toMatchObject({ status: 'Released', decision: 'Release' });

    // the rest within tolerance completes the PO
    const r2 = await receive(f, po.id, po.lineId, 1550);
    expect(r2.posted.poStatus).toBe('Received');
    expect((await f.keeper.post('/api/v1/goods-receipts', grn(po.id, po.lineId, 1)).expect(422)).body.error.code).toBe('INVALID_STATE_TRANSITION');
    // the ledger is append-only
    await expect(db.query(`delete from inv.stock_ledger where lot_id = $1`, [r1.lotId])).rejects.toThrow();
  });

  it('rejects and holds lots, rates the vendor, and short-closes the PO', async () => {
    const f = await setup();
    const vendor = await activeVendor(f, [f.rm]);
    const po = await issuedPo(f, vendor, 1000);
    const { analyst, manager } = await qcUsers();

    const a = await receive(f, po.id, po.lineId, 400);
    await analyst.post(`/api/v1/qc/inspections/${a.inspectionId}/sample`, { sampleQty: 0 }).expect(200);
    await analyst.post(`/api/v1/qc/inspections/${a.inspectionId}/results`, { results: [{ ...pass[0], result: '30.1%', pass: false }], coaReceived: true, recommendation: 'Reject' }).expect(200);
    await manager.post(`/api/v1/qc/inspections/${a.inspectionId}/decide`, { decision: 'Reject' }).expect(400);
    const rej = await manager.post(`/api/v1/qc/inspections/${a.inspectionId}/decide`, { decision: 'Reject', remarks: 'Zinc below specification' }).expect(200);
    expect(rej.body).toEqual({ lotStatus: 'Rejected', vendorRating: 1.5 });
    expect(await lotStock(a.lotId)).toEqual({ QUARANTINE: 0, REJECTED: 400 });

    const b = await receive(f, po.id, po.lineId, 300);
    await analyst.post(`/api/v1/qc/inspections/${b.inspectionId}/sample`, { sampleQty: 0 }).expect(200);
    await analyst.post(`/api/v1/qc/inspections/${b.inspectionId}/results`, { results: pass, coaReceived: true, recommendation: 'Hold' }).expect(200);
    await manager.post(`/api/v1/qc/inspections/${b.inspectionId}/decide`, { decision: 'Hold', remarks: 'Bag labels unclear; confirm with vendor' }).expect(200);
    expect(await lotStock(b.lotId)).toEqual({ QUARANTINE: 0, BLOCKED: 300 });
    const rel = await manager.post(`/api/v1/qc/inspections/${b.inspectionId}/decide`, { decision: 'Release' }).expect(200);
    expect(rel.body.vendorRating).toBe(3.3);      // 1 of 2 lots accepted (70% × ½), both on time (30%)
    expect(await lotStock(b.lotId)).toEqual({ QUARANTINE: 0, BLOCKED: 0, UNRESTRICTED: 300 });

    // 700 of 1000 received; the balance is closed short
    let d = (await f.pe.get(`/api/v1/purchase-orders/${po.id}`).expect(200)).body;
    expect(d).toMatchObject({ status: 'PartiallyReceived' });
    expect(d.lines[0].receivedQty).toBe('700.0000');
    expect(d.allowedActions).toContain('close');
    await f.pe.post(`/api/v1/purchase-orders/${po.id}/cancel`, { reason: 'x' }).expect(422);
    await f.pe.post(`/api/v1/purchase-orders/${po.id}/close`, { reason: 'Vendor cannot supply the balance this season' }).expect(200);
    d = (await f.pe.get(`/api/v1/purchase-orders/${po.id}`).expect(200)).body;
    expect(d.status).toBe('Closed');
    expect((await f.pe.get(`/api/v1/vendors/${vendor}`).expect(200)).body.rating).toBe('3.3');
  });
});
