/**
 * Pure verification of transport selection/fallback ordering. `select.ts` has
 * only type-only imports, so it runs under tsx with no React Native present:
 *
 *   pnpm --filter @bosun/mobile exec tsx scripts/verify-transport-select.ts
 */
import { orderTransports } from "../src/transport/select";
import type { MobileTransport } from "../src/transport/types";
import type { StoredSupervisor } from "../src/storage";

let failures = 0;
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "✔" : "✖"} ${label}`);
  if (!ok) failures++;
};

function fakeTransport(
  id: "lan" | "p2p",
  available: boolean,
  reachable: boolean,
): MobileTransport {
  return {
    id,
    isAvailable: () => available,
    canReach: () => reachable,
    connect: () => Promise.reject(new Error("not used")),
  };
}

const sup = (over: Partial<StoredSupervisor> = {}): StoredSupervisor => ({
  name: "s",
  supervisorPublicKey: "pk",
  lastAddrs: [{ host: "10.0.0.2", port: 45450 }],
  p2pTicket: "ticket",
  ...over,
});

const lan = (a: boolean, r: boolean) => fakeTransport("lan", a, r);
const p2p = (a: boolean, r: boolean) => fakeTransport("p2p", a, r);

// LAN before P2P when both usable and no preference.
check(
  "LAN precedes P2P by default",
  orderTransports(sup(), [p2p(true, true), lan(true, true)]).map((t) => t.id)
    .join(",") === "lan,p2p",
);

// Preferred transport goes first.
check(
  "preferredTransport wins",
  orderTransports(sup({ preferredTransport: "p2p" }), [
    lan(true, true),
    p2p(true, true),
  ])[0]?.id === "p2p",
);

// Unavailable transport (no native module) is dropped.
check(
  "unavailable P2P dropped",
  orderTransports(sup(), [lan(true, true), p2p(false, true)]).map((t) => t.id)
    .join(",") === "lan",
);

// Unreachable transport (no ticket / no addr) is dropped.
check(
  "unreachable LAN dropped",
  orderTransports(sup({ lastAddrs: [] }), [lan(true, false), p2p(true, true)])
    .map((t) => t.id)
    .join(",") === "p2p",
);

// Nothing usable → empty (controller turns this into a clear error).
check(
  "no usable transport → empty",
  orderTransports(sup(), [lan(false, true), p2p(false, true)]).length === 0,
);

console.log(failures === 0 ? "\nselect: ALL PASS" : `\nselect: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
