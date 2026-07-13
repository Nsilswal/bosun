export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  /** Fraction of the delay applied as ± random jitter (0..1). */
  jitter?: number;
}

/**
 * Exponential backoff with full-range jitter, for reconnect scheduling.
 * `attempt` is 1-based (first retry = 1). Jitter spreads reconnect storms and
 * the cap keeps a long-backgrounded app from waiting minutes to recover.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const { baseMs = 1000, maxMs = 30_000, factor = 2, jitter = 0.3 } = opts;
  const capped = Math.min(maxMs, baseMs * factor ** Math.max(0, attempt - 1));
  const spread = capped * jitter;
  return Math.round(capped - spread + Math.random() * 2 * spread);
}
