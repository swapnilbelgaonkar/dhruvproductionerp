import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import type { Config } from './config';
import type { Db } from './db/pool';
import { loadSession, requireAuth } from './middleware/auth';
import { errorHandler } from './middleware/errors';
import { adminRoutes, auditRoutes, dashboardRoutes, searchRoutes } from './modules/admin/routes';
import { authRoutes } from './modules/auth/routes';
import { meRoutes, roleRoutes, userRoutes } from './modules/iam/routes';
import { orgRoutes } from './modules/org/routes';
import { approvalRoutes, policyRoutes } from './modules/workflow/routes';
import { idempotency } from './middleware/idempotency';
import { documentRoutes } from './modules/documents/routes';
import { LocalDiskStorage, type FileStorage } from './modules/documents/storage';
import { mdmRoutes } from './modules/mdm/routes';
import { dealerRoutes } from './modules/dealers/routes';
import { crmRoutes } from './modules/crm/routes';
import { notificationRoutes } from './modules/notifications/routes';
import { pricingRoutes } from './modules/sales/pricing';
import { quotationRoutes } from './modules/sales/quotations';
import { salesOrderRoutes } from './modules/sales/orders';
import { vendorRoutes } from './modules/vendors/routes';
import { requisitionRoutes } from './modules/purchase/requisitions';
import { rfqRoutes } from './modules/purchase/rfqs';
import { purchaseOrderRoutes } from './modules/purchase/orders';

export function createApp(db: Db, cfg: Config, storage: FileStorage = new LocalDiskStorage(cfg.STORAGE_DIR)) {
  const log = pino({ level: cfg.NODE_ENV === 'test' ? 'silent' : 'info' });
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use((req, res, next) => {
    req.requestId = (req.get('x-request-id') ?? randomUUID()).slice(0, 64);
    res.setHeader('x-request-id', req.requestId);
    next();
  });
  if (cfg.NODE_ENV !== 'test') app.use(pinoHttp({ logger: log, genReqId: (req) => (req as express.Request).requestId ?? randomUUID() }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', async (_req, res) => {
    await db.query('select 1');
    res.json({ ok: true });
  });

  const v1 = express.Router();
  v1.use(loadSession(db));
  v1.use('/auth', authRoutes(db, cfg));
  v1.use(requireAuth);
  v1.use(idempotency(db));
  v1.use('/me', meRoutes());
  v1.use('/users', userRoutes(db));
  v1.use('/roles', roleRoutes(db));
  v1.use('/approvals', approvalRoutes(db));
  v1.use('/approval-policies', policyRoutes(db));
  v1.use('/audit', auditRoutes(db));
  v1.use('/admin', adminRoutes(db));
  v1.use('/dashboard', dashboardRoutes(db));
  v1.use('/search', searchRoutes(db));
  v1.use('/documents', documentRoutes(db, cfg, storage));
  v1.use('/notifications', notificationRoutes(db));
  v1.use('/dealers', dealerRoutes(db));
  v1.use('/crm', crmRoutes(db));
  v1.use('/price-lists', pricingRoutes(db));
  v1.use('/quotations', quotationRoutes(db));
  v1.use('/sales-orders', salesOrderRoutes(db));
  v1.use('/vendors', vendorRoutes(db, cfg));
  v1.use('/purchase-requisitions', requisitionRoutes(db));
  v1.use('/rfqs', rfqRoutes(db));
  v1.use('/purchase-orders', purchaseOrderRoutes(db));
  v1.use('/', mdmRoutes(db));
  v1.use('/', orgRoutes(db));
  app.use('/api/v1', v1);

  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint.' } }));
  app.use(errorHandler(log));
  return app;
}
