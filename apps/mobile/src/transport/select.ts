import type { StoredSupervisor } from "../storage";
import type { MobileTransport } from "./types";

/**
 * Order the transports to try for a supervisor, most-preferred first. A
 * transport is a candidate only if it's available in this build AND has the
 * coordinates to reach this supervisor. The transport that last worked
 * (`preferredTransport`) is tried first; otherwise LAN before P2P (LAN is
 * faster and infra-free when both are reachable).
 *
 * Pure and RN-free so it can be unit-tested directly.
 */
export function orderTransports(
  sup: StoredSupervisor,
  transports: readonly MobileTransport[],
): MobileTransport[] {
  const usable = transports.filter(
    (t) => t.isAvailable() && t.canReach(sup),
  );
  const rank = (t: MobileTransport): number => {
    if (t.id === sup.preferredTransport) return 0;
    return t.id === "lan" ? 1 : 2;
  };
  return usable.sort((a, b) => rank(a) - rank(b));
}
