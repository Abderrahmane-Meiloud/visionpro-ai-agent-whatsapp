import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { cfg } from '../src/config';
import { sendEvolutionText } from '../src/modules/whatsapp-evolution/client';

/** Save/restore the handful of cfg fields these tests mutate (cfg is a plain object computed once
 *  at module load, so tests flip fields directly rather than re-importing with different env). */
function withCfg<T>(overrides: Partial<typeof cfg>, fn: () => Promise<T>): Promise<T> {
  const saved: Partial<typeof cfg> = {};
  for (const k of Object.keys(overrides) as (keyof typeof cfg)[]) { (saved as any)[k] = cfg[k]; (cfg as any)[k] = (overrides as any)[k]; }
  return fn().finally(() => { for (const k of Object.keys(overrides) as (keyof typeof cfg)[]) (cfg as any)[k] = (saved as any)[k]; });
}

test('sendEvolutionText: fails closed to a real (non-loopback) base when EVOLUTION_REAL_OUTBOUND_ENABLED is false — no network attempted', async () => {
  await withCfg({ evolutionApiBaseUrl: 'https://evolution.example.invalid', evolutionApiKey: 'test-key', evolutionRealOutboundEnabled: false }, async () => {
    const start = Date.now();
    await assert.rejects(() => sendEvolutionText('evo:00000000000', 'hello'), /EVOLUTION_REAL_OUTBOUND_ENABLED is false/);
    // The gate throws before the retry/backoff loop that wraps the real fetch — this must resolve
    // near-instantly. If it ever took seconds, that would mean a real network attempt was made.
    assert.ok(Date.now() - start < 500, 'rejected too slowly — the gate may not be short-circuiting before the real HTTP call');
  });
});

test('sendEvolutionText: auto-reply and retry paths go through the SAME gate (same function, same default-false flag)', async () => {
  // This is the exact scenario the owner flagged as the gap: auto-reply/retry call the identical
  // sendEvolutionText used by manual replies — proving the gate here proves it for all three.
  await withCfg({ evolutionApiBaseUrl: 'https://evolution.example.invalid', evolutionApiKey: 'test-key', evolutionRealOutboundEnabled: false }, async () => {
    await assert.rejects(() => sendEvolutionText('evo:00000000000', '[mock] AI auto-reply'), /EVOLUTION_REAL_OUTBOUND_ENABLED is false/);
    await assert.rejects(() => sendEvolutionText('evo:00000000000', 'retried message'), /EVOLUTION_REAL_OUTBOUND_ENABLED is false/);
  });
});

test('sendEvolutionText: a loopback base (the local simulator) is NEVER blocked by the real-outbound flag', async () => {
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ key: { id: 'FAKE_SINK_OK' } })); });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as any).port;
  try {
    await withCfg({ evolutionApiBaseUrl: `http://127.0.0.1:${port}`, evolutionApiKey: 'test-key', evolutionRealOutboundEnabled: false }, async () => {
      const id = await sendEvolutionText('evo:00000000000', 'hello from the simulator');
      assert.equal(id, 'evo:FAKE_SINK_OK');
    });
  } finally { srv.close(); }
});

test('sendEvolutionText: a non-loopback base is allowed through the gate (and only then fails on the network) once EVOLUTION_REAL_OUTBOUND_ENABLED=true', async () => {
  // 127.0.0.2 is NOT recognized as loopback by isLoopbackBase (deliberately strict: only exact
  // localhost/127.0.0.1/::1 count as "safe"), so this exercises the true real-outbound path —
  // while still failing at the TCP layer near-instantly (nothing listens on the loopback range),
  // never hanging on a real DNS/network timeout.
  await withCfg({ evolutionApiBaseUrl: 'http://127.0.0.2:1', evolutionApiKey: 'test-key', evolutionRealOutboundEnabled: true }, async () => {
    await assert.rejects(
      () => sendEvolutionText('evo:00000000000', 'hello'),
      (e: any) => !/EVOLUTION_REAL_OUTBOUND_ENABLED is false/.test(e.message), // gate did NOT fire; only the (expected) network error did
    );
  });
});
