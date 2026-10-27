/**
 * Standalone, explicit migration runner. Lives in src/ so it compiles to dist/migrate.js and can run
 * in the production image (which has no dev deps / tsx). Applies the idempotent schema.sql once.
 *
 * Production procedure (run deliberately, BEFORE starting the app with AUTO_MIGRATE unset):
 *   dev/test:  npm run migrate:dev           (uses tsx)
 *   built:     npm run build && npm run migrate   (node dist/migrate.js, DATABASE_URL set)
 *   docker:    docker compose run --rm api node dist/migrate.js
 */
import { migrate, pool } from './db';
import { log } from './log';

migrate()
  .then(() => log.info('migrate.applied'))
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((e) => { log.error('migrate.failed', { err: e?.message }); process.exit(1); });
