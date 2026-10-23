import express from 'express';
import { assertProdConfig, cfg } from './config';
import { migrate, pool } from './db';
import { admin } from './modules/admin';
import { recoverPending } from './modules/conversations';
import { webhook } from './modules/whatsapp/webhook';

async function main() {
  assertProdConfig();
  await migrate();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Traefik
  app.use(webhook); // raw-body route; must come before any JSON parser
  app.use(admin);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('unhandled', err?.message);
    res.status(500).json({ error: 'internal' });
  });
  const server = app.listen(cfg.port, () => console.log(`api listening on :${cfg.port}`));
  await recoverPending();
  const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
main().catch((e) => { console.error(e); process.exit(1); });
