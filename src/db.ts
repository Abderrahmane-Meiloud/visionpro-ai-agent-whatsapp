import fs from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { cfg } from './config';

export const pool = new Pool({ connectionString: cfg.databaseUrl, max: 10 });

export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params as any[])).rows as T[];
}

/** Run `fn` inside a single transaction (BEGIN/COMMIT, ROLLBACK on throw). Used for the
 *  transactional order confirmation (revalidate price/stock + decrement + flip state atomically). */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function migrate() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const r = await q('SELECT value FROM agent_settings WHERE key=$1', [key]);
  return r.length ? (r[0].value as T) : fallback;
}

export async function setSetting(key: string, value: unknown, by: string) {
  const old = await getSetting(key, null);
  await q(
    `INSERT INTO agent_settings(key,value,updated_by) VALUES($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET value=$2, updated_by=$3, updated_at=now()`,
    [key, JSON.stringify(value), by],
  );
  await audit(by, 'setting.update', 'agent_settings', key, old, value);
}

export async function audit(actor: string, action: string, entityType: string, entityId: string | number, oldV: unknown, newV: unknown, source = 'admin') {
  await q(
    `INSERT INTO audit_logs(actor,action,entity_type,entity_id,old_value,new_value,source) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [actor, action, entityType, String(entityId), JSON.stringify(oldV ?? null), JSON.stringify(newV ?? null), source],
  );
}
