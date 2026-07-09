import { connectClient, type Identity } from "@bosun/transport/client-core";
import type { StoredSupervisor } from "../storage";
import type { MobileTransport } from "./types";
import { isNativeIrohAvailable, openIrohSocket } from "./native-iroh";

/** Off-Wi-Fi transport: iroh QUIC via the native module, dialed by ticket. */
export const p2pTransport: MobileTransport = {
  id: "p2p",
  isAvailable: () => isNativeIrohAvailable(),
  canReach: (sup: StoredSupervisor) => typeof sup.p2pTicket === "string",
  connect: async (sup: StoredSupervisor, identity: Identity) => {
    const socket = await openIrohSocket(sup.p2pTicket!);
    return connectClient(socket, identity, {
      expectedServerPublicKey: sup.supervisorPublicKey,
    });
  },
};
