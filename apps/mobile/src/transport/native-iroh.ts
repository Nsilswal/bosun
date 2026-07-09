import { requireOptionalNativeModule } from "expo-modules-core";
import type { RawSocket } from "@bosun/transport/client-core";

/**
 * JS contract for the `BosunIroh` native module (Swift/Kotlin, wrapping iroh's
 * official mobile bindings). The module is OPTIONAL: `requireOptionalNativeModule`
 * returns null in builds that don't include it, so the app degrades to
 * LAN-only cleanly. Implementing the native side is the remaining P2P task —
 * see docs/mobile-p2p.md.
 *
 * The native module only has to move bytes across NAT; Bosun's pairing,
 * mutual-auth handshake, allowlist, and encryption all run in JS on top of the
 * `RawSocket` this bridge exposes, exactly as they do over LAN WebSocket.
 */
interface IrohDataEvent {
  handle: string;
  data: string;
}
interface IrohCloseEvent {
  handle: string;
}

interface NativeIrohModule {
  /** Dial a supervisor by its iroh ticket; resolves to a connection handle. */
  connect(ticket: string): Promise<string>;
  /** Send one length-agnostic message frame (native side handles framing). */
  send(handle: string, data: string): Promise<void>;
  close(handle: string): void;
  addListener(
    event: "onData",
    listener: (e: IrohDataEvent) => void,
  ): { remove(): void };
  addListener(
    event: "onClose",
    listener: (e: IrohCloseEvent) => void,
  ): { remove(): void };
}

const Native = requireOptionalNativeModule<NativeIrohModule>("BosunIroh");

export function isNativeIrohAvailable(): boolean {
  return Native != null;
}

/**
 * Open an iroh connection through the native module and adapt it to the same
 * `RawSocket` the LAN transport produces, so `connectClient` is transport-blind.
 */
export async function openIrohSocket(ticket: string): Promise<RawSocket> {
  if (!Native) {
    throw new Error(
      "P2P needs the BosunIroh native module, which isn't in this build. " +
        "Use LAN, or build the app with the native iroh module (docs/mobile-p2p.md).",
    );
  }
  const handle = await Native.connect(ticket);
  const messageListeners = new Set<(data: string) => void>();
  const closeListeners = new Set<() => void>();

  const dataSub = Native.addListener("onData", (e) => {
    if (e.handle === handle) for (const cb of messageListeners) cb(e.data);
  });
  const closeSub = Native.addListener("onClose", (e) => {
    if (e.handle !== handle) return;
    for (const cb of closeListeners) cb();
    dataSub.remove();
    closeSub.remove();
  });

  return {
    send: (data) => {
      void Native.send(handle, data).catch(() => undefined);
    },
    close: () => {
      Native.close(handle);
      dataSub.remove();
      closeSub.remove();
    },
    onMessage: (cb) => {
      messageListeners.add(cb);
    },
    onClose: (cb) => {
      closeListeners.add(cb);
    },
  };
}
