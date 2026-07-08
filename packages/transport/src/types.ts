import type {
  Envelope,
  PairError,
  PairOk,
  PairRequest,
  QrPayload,
} from "@bosun/protocol";

export type Unsubscribe = () => void;

/**
 * An authenticated, encrypted channel to a peer. This is the ONLY surface
 * callers (supervisor core, app screens) see — never sockets, addresses, or
 * NAT concerns. Every transport implementation (LAN today, P2P next) yields
 * these.
 */
export interface PeerConnection {
  /** Authenticated static Ed25519 public key of the peer (base64url). */
  readonly peerPublicKey: string;
  send(envelope: Envelope): void;
  onMessage(cb: (envelope: Envelope) => void): Unsubscribe;
  onClose(cb: () => void): Unsubscribe;
  close(): void;
}

/** Decides pairing requests; owned by the supervisor (token lifecycle). */
export type PairingHandler = (req: PairRequest) => PairOk | PairError;

export interface TransportServerOptions {
  identity: import("./crypto.js").Identity;
  /** Human-readable supervisor name (shows in discovery + the app). */
  name: string;
  /** 0 (default) picks an ephemeral port. */
  port?: number;
  /** Allowlist check: is this device public key paired? */
  isAuthorized(devicePublicKey: string): boolean;
  onPairRequest: PairingHandler;
  /** Advertise over mDNS/Bonjour (default true; off in tests). */
  advertise?: boolean;
}

export interface TransportServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Reachable LAN addresses, for the QR payload. */
  addresses(): { host: string; port: number }[];
  buildQrPayload(pairingToken: string, expiresAt: number): QrPayload;
  onConnection(cb: (conn: PeerConnection) => void): Unsubscribe;
}

/** A supervisor the client has paired with (persisted app-side). */
export interface PairedSupervisor {
  name: string;
  supervisorPublicKey: string;
  lastAddrs: { host: string; port: number }[];
}

export interface DiscoveredSupervisor {
  name: string;
  addrs: { host: string; port: number }[];
  /** Present when the advertisement carries the supervisor key. */
  supervisorPublicKey?: string;
}
