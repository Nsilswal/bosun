import { connectClient, type Identity } from "@bosun/transport/client-core";
import type { StoredSupervisor } from "../storage";
import type { MobileTransport } from "./types";
import { firstReachableWs } from "./ws-socket";

/** Same-network transport: WebSocket to an advertised LAN address. */
export const lanTransport: MobileTransport = {
  id: "lan",
  isAvailable: () => true,
  canReach: (sup: StoredSupervisor) => sup.lastAddrs.length > 0,
  connect: async (sup: StoredSupervisor, identity: Identity) => {
    const socket = await firstReachableWs(sup.lastAddrs);
    return connectClient(socket, identity, {
      expectedServerPublicKey: sup.supervisorPublicKey,
    });
  },
};
