import type {
  Identity,
  PeerConnection,
} from "@bosun/transport/client-core";
import type { StoredSupervisor, TransportId } from "../storage";

/**
 * A way for the app to reach its supervisor. The two implementations (LAN
 * WebSocket, iroh P2P) both run the identical `connectClient` handshake — they
 * differ only in how they obtain the underlying byte channel.
 */
export interface MobileTransport {
  readonly id: TransportId;
  /** Can this transport run at all in this build (e.g. native module present)? */
  isAvailable(): boolean;
  /** Do we have the coordinates to reach this supervisor via it? */
  canReach(sup: StoredSupervisor): boolean;
  connect(sup: StoredSupervisor, identity: Identity): Promise<PeerConnection>;
}

export interface ConnectOutcome {
  conn: PeerConnection;
  transport: TransportId;
}
