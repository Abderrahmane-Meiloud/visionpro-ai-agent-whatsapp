import crypto from 'node:crypto';
import express from 'express';
import { assertProdConfig, cfg } from './config';
import { migrate, pool } from './db';
import { log } from './log';
import { admin } from './modules/admin';
import { ensureBootstrapAdmin } from './modules/auth/users';
import { sweepExpiredSessions } from './modules/auth/session';
import { recoverPending } from './modules/conversations';
import { webhook } from './modules/whatsapp/webhook';
import { evolutionWebhook } from './modules/whatsapp-evolution/webhook';
import { evolutionSimulate } from './modules/whatsapp-evolution/simulate';

async function main() {
  assertProdConfig();
  // In production the schema is NOT auto-applied at boot (it can lock a populated DB); the operator
  // runs `npm run migrate` deliberately. Dev/test auto-migrate for convenience (AUTO_MIGRATE=true).
  if (cfg.autoMigrate) await migrate();
  else log.warn('migrate.auto_skipped', { hint: 'run the migration step (npm run migrate) before first boot; set AUTO_MIGRATE=true only for dev/test' });
  // Seed the DB admin from the env bootstrap credentials ONLY if no users exist yet, so the owner
  // can log into the dashboard immediately. Idempotent; never overwrites an existing account.
  await ensureBootstrapAdmin(cfg.adminUser, cfg.adminPassword);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Traefik

  // Request id + baseline security headers. Does NOT read the body, so it is safe before the
  // webhook raw-body route. The id is echoed back and threaded into logs for correlation.
  app.use((req, res, next) => {
    const id = (req.header('x-request-id') || crypto.randomUUID()).slice(0, 64);
    (req as any).reqId = id;
    res.setHeader('x-request-id', id);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Cache-Control', 'no-store');
    if (cfg.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  app.use(webhook); // raw-body route; must come before any JSON parser
  app.use(admin);
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log.error('unhandled', { reqId: (req as any).reqId, err: err?.message });
    res.status(500).json({ error: 'internal' });
  });
  const server = app.listen(cfg.port, () => log.info('listening', { port: cfg.port }));

  // Evolution API pilot (EXPERIMENTAL, owner-authorized, non-production — docs/26_EVOLUTION_PILOT.md):
  // a SECOND, minimal listener that serves nothing but the pilot webhook route. Only this port
  // should ever be exposed via a tunnel; the main `server` above (admin + Meta webhook) never is.
  // Only starts when EVOLUTION_API_BASE_URL is set; assertProdConfig() already refused to boot in
  // production if it is, so this can only ever run in dev.
  let evoServer: import('http').Server | undefined;
  if (cfg.evolutionApiBaseUrl) {
    const evoApp = express();
    evoApp.disable('x-powered-by');
    evoApp.set('trust proxy', 1);
    evoApp.use(evolutionWebhook);
    if (cfg.evolutionPilotSimulationMode) evoApp.use(evolutionSimulate);
    evoServer = evoApp.listen(cfg.evolutionWebhookPort, () =>
      log.info('evolution_pilot.listening', { port: cfg.evolutionWebhookPort, instance: cfg.evolutionInstanceName, simulationMode: cfg.evolutionPilotSimulationMode }));
  } else {
    log.info('evolution_pilot.disabled', { hint: 'set EVOLUTION_API_BASE_URL to enable the isolated pilot webhook receiver (docs/26_EVOLUTION_PILOT.md)' });
  }

  await recoverPending();
  // Periodically purge expired sessions (also purged lazily on resolve).
  const sweep = setInterval(() => void sweepExpiredSessions().catch((e) => log.warn('session.sweep_failed', { err: e?.message })), 3_600_000);
  sweep.unref?.();
  const stop = () => server.close(() => (evoServer ? evoServer.close(() => pool.end().then(() => process.exit(0))) : pool.end().then(() => process.exit(0))));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
main().catch((e) => { log.error('boot_failed', { err: e?.message }); process.exit(1); });
