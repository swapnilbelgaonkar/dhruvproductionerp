import { createApp } from './app';
import { loadConfig } from './config';
import { createPool } from './db/pool';
import { startRelay } from './modules/notifications/relay';

const cfg = loadConfig();
const db = createPool(cfg.DATABASE_URL);
const app = createApp(db, cfg);

const server = app.listen(cfg.PORT, () => console.log(`Dhruv ERP API listening on :${cfg.PORT}`));
// In production the relay runs in the separate worker process (src/worker.ts); RUN_RELAY=false disables it here.
const stopRelay = process.env.RUN_RELAY === 'false' ? () => undefined : startRelay(db);
const shutdown = () => { stopRelay(); server.close(() => db.end().then(() => process.exit(0))); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
