/**
 * Tiny in-memory failure throttle, shared by the webhook (bad-signature abuse) and the admin
 * login (failed auth). It ONLY ever counts failures: a request with a valid signature / correct
 * credentials never touches it, so legitimate Meta retries and the VisionPro bridge are never
 * blocked. Counts expire after a rolling window. Pure/time-injectable so it is unit-testable.
 */
export class FailureThrottle {
  private readonly hits = new Map<string, { n: number; exp: number }>();
  constructor(private readonly max: number, private readonly windowMs: number) {}

  private live(key: string, now: number) {
    const e = this.hits.get(key);
    if (!e || e.exp <= now) { if (e) this.hits.delete(key); return null; }
    return e;
  }

  /** True once `max` failures have been recorded within the window for this key. */
  blocked(key: string, now = Date.now()): boolean {
    const e = this.live(key, now);
    return !!e && e.n >= this.max;
  }

  /** Record one failure for this key. */
  record(key: string, now = Date.now()): void {
    if (this.hits.size > 10_000) this.hits.clear(); // hard cap: never grow unbounded
    const e = this.live(key, now);
    if (e) e.n += 1;
    else this.hits.set(key, { n: 1, exp: now + this.windowMs });
  }

  /** Clear a key after a success. */
  reset(key: string): void { this.hits.delete(key); }
}
