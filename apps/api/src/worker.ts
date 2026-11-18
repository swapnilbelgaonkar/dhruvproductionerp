/** Background worker process (doc 03 §2): outbox relay now; PDFs, e-mail and schedulers join here in later stages. */
import { loadConfig } from './config';
import { createPool } from './db/pool';
import { startRelay } from './modules/notifications/relay';

const cfg = loadConfig();
const db = createPool(cfg.DATABASE_URL);
const stop = startRelay(db, 1000);
console.log('Dhruv ERP worker started');
const shutdown = () => { stop(); db.end().then(() => process.exit(0)); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
