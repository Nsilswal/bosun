import AsyncStorage from "@react-native-async-storage/async-storage";
import type { PairedSupervisor } from "@bosun/transport/client-core";

const KEY = "bosun.pairedSupervisor";

export async function loadSupervisor(): Promise<PairedSupervisor | null> {
  const raw = await AsyncStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as PairedSupervisor) : null;
}

export async function saveSupervisor(sup: PairedSupervisor): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(sup));
}

export async function forgetSupervisor(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
