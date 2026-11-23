import { describe, expect, it } from 'vitest';
import { todayIST } from '../src/modules/sales/quotations';
import { userAgent } from './helpers';
import { ready, release } from './dispatch-fixtures';

describe('Mobile scanning (D09): scan lookup and offline-safe picking', () => {
  it('identifies boxes and lots from a serial, a label QR link or a lot number, and replays a queued pick without picking twice', async () => {
    const x = await ready();
    const box = x.boxes[0]!.serial;
    const lotNo = (await x.keeper.get(`/api/v1/stock/scan/${box}`).expect(200)).body.box.lotNo;
    let s = (await x.keeper.get(`/api/v1/stock/scan/${box}`).expect(200)).body;
    expect(s).toMatchObject({ kind: 'box', box: { serial: box, units: 12, qcStatus: 'Quarantine' }, verdict: 'Lot not released by QA — do not dispatch' });
    await release(x.fgLot, x.f.fgWh);
    const qr = encodeURIComponent(`https://erp.example.in/verify/${box}?s=abcdef`);
    s = (await x.keeper.get(`/api/v1/stock/scan/${qr}`).expect(200)).body;
    expect(s).toMatchObject({ kind: 'box', verdict: 'Ready to dispatch' });
    expect(s.stock).toEqual(expect.arrayContaining([expect.objectContaining({ bucket: 'UNRESTRICTED' })]));
    const lot = (await x.logistics.get(`/api/v1/stock/scan/${encodeURIComponent(lotNo.toLowerCase())}`).expect(200)).body;
    expect(lot).toMatchObject({ kind: 'lot', lot: { lotNo, qcStatus: 'Released', boxesReady: 4 }, verdict: 'Released for use' });
    await x.keeper.get('/api/v1/stock/scan/NOT-A-CODE').expect(404);
    const verifier = await userAgent([{ code: 'DOC_VERIFIER' }]);
    await verifier.get(`/api/v1/stock/scan/${box}`).expect(403);

    // a scan queued offline is sent with its own idempotency key; a retry after a lost reply replays the first answer
    const sh = await x.logistics.post('/api/v1/shipments', { salesOrderId: x.so, warehouseId: x.f.fgWh, plannedDate: todayIST(), lines: [{ soLineId: x.line, packs: 24 }] }).expect(201);
    const send = () => x.keeper.raw.post(`/api/v1/shipments/${sh.body.id}/pick`).set('x-csrf-token', x.keeper.csrf).set('idempotency-key', 'scan-dev1-0001').send({ boxSerial: box });
    const first = await send().expect(201);
    const again = await send().expect(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body).toEqual(first.body);
    const d = (await x.logistics.get(`/api/v1/shipments/${sh.body.id}`).expect(200)).body;
    expect(d.lines[0].pickedPacks).toBe('12.0000');
    expect((await x.keeper.get(`/api/v1/stock/scan/${box}`).expect(200)).body.verdict).toBe(`On shipment ${sh.body.docNo}`);
  });
});
