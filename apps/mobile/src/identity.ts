import * as SecureStore from "expo-secure-store";
import {
  generateIdentity,
  identityFromSecretKey,
  type StoredIdentity,
} from "@bosun/transport/client-core";

const KEY = "bosun.device.secretKey";

/** Device keypair, generated once and kept in the platform keychain. */
export async function loadDeviceIdentity(): Promise<StoredIdentity> {
  const existing = await SecureStore.getItemAsync(KEY);
  if (existing) return identityFromSecretKey(existing);
  const identity = generateIdentity();
  await SecureStore.setItemAsync(KEY, identity.secretKey);
  return identity;
}
