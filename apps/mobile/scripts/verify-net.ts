/**
 * Pure verification of reconnect backoff and heartbeat liveness (no RN):
 *   pnpm --filter @bosun/mobile exec tsx scripts/verify-net.ts
 */
import { backoffDelay } from "../src/net/backoff";
import { Heartbeat } from "../src/net/heartbeat";

let failures = 0;
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "✔" : "✖"} ${label}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
// ── backoff ────────────────────────────────────────────────────────────────
const opts = { baseMs: 1000, maxMs: 30_000, factor: 2, jitter: 0.3 };
const inRange = (attempt: number, lo: number, hi: number) => {
  for (let i = 0; i < 200; i++) {
    const d = backoffDelay(attempt, opts);
    if (d < lo || d > hi) return false;
  }
  return true;
};
check("attempt 1 delay ~1000ms ±30%", inRange(1, 700, 1300));
check("attempt 2 delay ~2000ms ±30%", inRange(2, 1400, 2600));
check("attempt 4 delay ~8000ms ±30%", inRange(4, 5600, 10_400));
check("delay capped at maxMs (+jitter)", inRange(20, 21_000, 39_000));
check(
  "monotonic-ish growth on average",
  backoffDelay(1, { ...opts, jitter: 0 }) < backoffDelay(3, { ...opts, jitter: 0 }),
);

// ── heartbeat: declares dead when no pong ────────────────────────────────────
{
  let pings = 0;
  let dead = false;
  const hb = new Heartbeat({
    intervalMs: 20,
    timeoutMs: 15,
    sendPing: () => pings++,
    onDead: () => {
      dead = true;
    },
  });
  hb.start();
  await sleep(60); // ping fires, no pong → dead
  check("heartbeat pings while alive", pings >= 1);
  check("heartbeat declares dead with no pong", dead);
  hb.stop();
}

// ── heartbeat: stays alive while pongs arrive ────────────────────────────────
{
  let dead = false;
  const hb = new Heartbeat({
    intervalMs: 20,
    timeoutMs: 15,
    sendPing: () => hb.notifyActivity(), // simulate an immediate pong
    onDead: () => {
      dead = true;
    },
  });
  hb.start();
  await sleep(80);
  check("heartbeat stays alive while pongs arrive", !dead);
  hb.stop();
}

// ── heartbeat: stop() prevents further death ─────────────────────────────────
{
  let dead = false;
  const hb = new Heartbeat({
    intervalMs: 10,
    timeoutMs: 10,
    sendPing: () => {},
    onDead: () => {
      dead = true;
    },
  });
  hb.start();
  hb.stop();
  await sleep(50);
  check("stopped heartbeat never fires onDead", !dead);
}

  console.log(failures === 0 ? "\nnet: ALL PASS" : `\nnet: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
