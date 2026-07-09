import AsyncStorage from "@react-native-async-storage/async-storage";
import type { PairedSupervisor } from "@bosun/transport/client-core";

const KEY = "bosun.pairedSupervisor";

export type TransportId = "lan" | "p2p";

/** App-side record of a paired supervisor. */
export interface StoredSupervisor extends PairedSupervisor {
  /** iroh ticket for the P2P transport, when the supervisor advertised one. */
  p2pTicket?: string;
  /** Transport that last connected; tried first on the next connect. */
  preferredTransport?: TransportId;
}

export async function loadSupervisor(): Promise<StoredSupervisor | null> {
  const raw = await AsyncStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as StoredSupervisor) : null;
}

export async function saveSupervisor(sup: StoredSupervisor): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(sup));
}

export async function forgetSupervisor(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
