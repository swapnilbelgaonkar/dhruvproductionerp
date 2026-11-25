import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { scanAlerts } from '../src/modules/alerts/alerts';
import { fill, nextRun, queueMessage, scanDealerReminders, sendQueued } from '../src/modules/integrations/messaging';
import { todayIST } from '../src/modules/sales/quotations';
import { db, uniq, userAgent } from './helpers';
import { dispatched } from './dispatch-fixtures';

const setMode = (code: string, mode: string, config = '{}', provider: string | null = null) => db.query(`update sys.integrations set mode = $2, config = $3, provider = $4 where code = $1`, [code, mode, config, provider]);
const inDays = (n: number) => { const d = new Date(`${todayIST()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

describe('E-mail, SMS and WhatsApp: alerts, dealer reminders and scheduled reports (D11, NOT-001)', () => {
  afterAll(async () => {
    for (const c of ['EMAIL', 'SMS', 'WHATSAPP']) await setMode(c, 'OFF');
    await db.query(`update sys.settings set value = '{"enabled": false, "daysBefore": 3, "overdueEveryDays": 7, "channels": ["EMAIL"]}' where key = 'dealer.reminders'`);
    await db.query(`update sys.alert_rules set channels = '{}'`);
  });

  it('works out schedule times in IST and fills templates', () => {
    const from = new Date('2026-11-25T03:00:00Z');                                       // Wed 08:30 IST
    expect(nextRun({ frequency: 'DAILY', hour_ist: 8 }, from).toISOString()).toBe('2026-11-26T02:30:00.000Z');
    expect(nextRun({ frequency: 'DAILY', hour_ist: 9 }, from).toISOString()).toBe('2026-11-25T03:30:00.000Z');
    expect(nextRun({ frequency: 'WEEKLY', weekday: 1, hour_ist: 8 }, from).toISOString()).toBe('2026-11-30T02:30:00.000Z');
    expect(nextRun({ frequency: 'MONTHLY', month_day: 1, hour_ist: 7 }, from).toISOString()).toBe('2026-12-01T01:30:00.000Z');
    expect(fill('Dear {{dealer}}, {{missing}}invoice {{invoiceNo}}', { dealer: 'Krishi', invoiceNo: 'SI/1' })).toBe('Dear Krishi, invoice SI/1');
  });

  it('sends alerts on the channels a user chose, and posts SMS to a live HTTPS gateway', async () => {
    await setMode('EMAIL', 'OFF');
    expect(await queueMessage(db, { channel: 'EMAIL', template: 'ALERT', to: 'x@y.in', vars: {}, dedupeKey: uniq('k') })).toBe(false);
    await setMode('EMAIL', 'SIMULATED');
    const qc = await userAgent([{ code: 'QC_MANAGER' }]);
    expect((await qc.get('/api/v1/messaging/me/channels').expect(200)).body.available).toEqual(['EMAIL']);
    expect((await qc.put('/api/v1/messaging/me/channels', { channels: ['SMS'] }).expect(422)).body.error.code).toBe('MOBILE_REQUIRED');
    await qc.put('/api/v1/messaging/me/channels', { channels: ['EMAIL', 'SMS'], mobile: '9822012345' }).expect(200);
    const admin = await userAgent([{ code: 'EXEC_ADMIN' }]);
    await admin.put('/api/v1/messaging/alert-rules/CALIBRATION_DUE/channels', { channels: ['EMAIL', 'SMS'] }).expect(200);
    const code = uniq('INS-').slice(0, 20);
    await db.query(`insert into qc.instruments (code, name, technique, interval_days, last_calibrated, calibration_due, status) values ($1,'[TEST] Balance','WEIGHING',180,$2,$3,'Active')`, [code, inDays(-178), inDays(2)]);
    await scanAlerts(db);
    const msgs = (await db.query(`select channel, to_address, subject, status from sys.messages where to_user_id = $1 order by channel`, [qc.userId])).rows;
    // SMS is still off: only the e-mail is queued
    expect(msgs).toEqual([{ channel: 'EMAIL', to_address: qc.email, subject: `Calibration due in 2 days — ${code}`, status: 'Queued' }]);
    await sendQueued(db, 50);
    expect((await db.query(`select status, mode, provider_ref from sys.messages where to_user_id = $1`, [qc.userId])).rows[0]).toMatchObject({ status: 'Sent', mode: 'SIMULATED' });

    // a live SMS gateway receives the rendered text with the bearer token from the environment
    const got: { auth?: string; body: Record<string, unknown> }[] = [];
    const srv = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"gw-1"}'); }); });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    try {
      process.env.TEST_SMS_TOKEN = 'tok-123';
      await setMode('SMS', 'LIVE', JSON.stringify({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/send`, tokenEnv: 'TEST_SMS_TOKEN', senderId: 'DHRUVA' }), 'WEBHOOK');
      await db.query(`update qc.instruments set calibration_due = $2 where code = $1`, [code, inDays(-1)]);    // worsens: everyone is told again
      await scanAlerts(db);
      await sendQueued(db, 50);
      const sms = got.find((g) => String(g.body.text).includes(code))!;
      expect(sms).toMatchObject({ auth: 'Bearer tok-123', body: { to: '9822012345', senderId: 'DHRUVA', text: `Calibration overdue — ${code}. [TEST] Balance: locked for QC results until calibrated -Dhruv Agro` } });
      expect((await db.query(`select status, provider_ref from sys.messages where to_user_id = $1 and channel = 'SMS'`, [qc.userId])).rows[0]).toEqual({ status: 'Sent', provider_ref: 'gw-1' });
    } finally { srv.close(); }
    // only the administrator tests channels and edits templates; unknown placeholders are refused
    await qc.post('/api/v1/messaging/messages/test', { channel: 'EMAIL', to: 'ops@example.in' }).expect(403);
    expect((await admin.post('/api/v1/messaging/messages/test', { channel: 'EMAIL', to: 'ops@example.in' }).expect(200)).body.message.status).toBe('Sent');
    expect((await admin.put('/api/v1/messaging/message-templates/ALERT/SMS', { body: '{{title}} {{secret}}' }).expect(422)).body.error.code).toBe('UNKNOWN_PLACEHOLDER');
    await admin.put('/api/v1/messaging/message-templates/ALERT/SMS', { body: '{{title}}. {{body}} -Dhruv Agro', providerTemplateId: '1107160000000012345' }).expect(200);
  });

  it('reminds a dealer before the due date and every few days while overdue, once per step', async () => {
    const x = await dispatched();
    await db.query(`update mdm.parties set email = 'accounts@krishi.example' where id = $1`, [x.party]);
    await db.query(`update sales.invoices set invoice_date = $2, due_date = $3 where id = $1`, [x.invoice.id, inDays(-28), inDays(2)]);
    await setMode('EMAIL', 'SIMULATED');
    expect(await scanDealerReminders(db)).toBe(0);                                       // reminders are off by default
    const admin = await userAgent([{ code: 'EXEC_ADMIN' }]);
    await admin.put('/api/v1/messaging/dealer-reminders', { enabled: true, daysBefore: 3, overdueEveryDays: 7, channels: ['EMAIL'] }).expect(200);
    await scanDealerReminders(db);
    await scanDealerReminders(db);
    let m = (await db.query(`select template, subject, body from sys.messages where to_party_id = $1 order by created_at`, [x.party])).rows;
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ template: 'DEALER_PAYMENT_DUE', subject: expect.stringContaining(x.invoice.docNo) });
    expect(m[0].body).toContain('₹5,040.00');
    await db.query(`update sales.invoices set due_date = $2 where id = $1`, [x.invoice.id, inDays(-8)]);
    await scanDealerReminders(db);
    await scanDealerReminders(db);
    m = (await db.query(`select template, body from sys.messages where to_party_id = $1 order by created_at`, [x.party])).rows;
    expect(m.map((y) => y.template)).toEqual(['DEALER_PAYMENT_DUE', 'DEALER_PAYMENT_OVERDUE']);
    expect(m[1].body).toContain('8 days overdue');
  });

  it('e-mails a scheduled report limited to what its owner may see', async () => {
    await setMode('EMAIL', 'SIMULATED');
    const owner = await userAgent([{ code: 'MANAGEMENT_VIEWER' }]);
    const reader = await userAgent([{ code: 'SALES_OPS' }]);
    await reader.post('/api/v1/messaging/report-schedules', {}).expect(403);
    const bad = { name: '[TEST] Ledger', reportId: 'nope', frequency: 'DAILY', recipientUserIds: [reader.userId] };
    expect((await owner.post('/api/v1/messaging/report-schedules', bad).expect(422)).body.error.code).toBe('UNKNOWN_REPORT');
    await owner.post('/api/v1/messaging/report-schedules', { ...bad, reportId: 'sales-orders', frequency: 'WEEKLY' }).expect(400);
    const s = (await owner.post('/api/v1/messaging/report-schedules', { ...bad, name: '[TEST] Orders weekly', reportId: 'sales-orders', frequency: 'WEEKLY', weekday: 1, hourIst: 8 }).expect(201)).body;
    const list = (await owner.get('/api/v1/messaging/report-schedules').expect(200)).body.data;
    expect(list.find((y: { id: string }) => y.id === s.id)).toMatchObject({ frequency: 'WEEKLY', weekday: 1, recipients: [expect.any(String)] });
    const run = (await owner.post(`/api/v1/messaging/report-schedules/${s.id}/run`).expect(200)).body.status;
    expect(run).toMatch(/^Sent to 1: \d+ rows$/);
    const msg = (await db.query(`select subject, attachments from sys.messages where to_user_id = $1 and template = 'REPORT'`, [reader.userId])).rows[0];
    expect(msg.subject).toContain('Sales order grid');
    expect(msg.attachments[0]).toMatchObject({ contentType: 'text/csv', name: expect.stringMatching(/^sales-orders-/) });
    expect(Buffer.from(msg.attachments[0].base64, 'base64').toString()).toContain('﻿');
    await reader.delete(`/api/v1/messaging/report-schedules/${s.id}`).expect(403);
    await owner.delete(`/api/v1/messaging/report-schedules/${s.id}`).expect(200);
  });
});
