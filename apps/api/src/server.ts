import { createApp } from './app';
import { loadConfig } from './config';
import { createPool } from './db/pool';

const cfg = loadConfig();
const db = createPool(cfg.DATABASE_URL);
const app = createApp(db, cfg);

const server = app.listen(cfg.PORT, () => console.log(`Dhruv ERP API listening on :${cfg.PORT}`));
const shutdown = () => server.close(() => db.end().then(() => process.exit(0)));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
