import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  generateIdentity,
  identityFromSecretKey,
  type StoredIdentity,
} from "@bosun/transport";

/**
 * Supervisor state on disk, under ~/.bosun (override: BOSUN_HOME):
 *   identity.json  — Ed25519 secret key (0600)
 *   devices.json   — paired-device allowlist
 */

export function bosunHome(): string {
  return process.env.BOSUN_HOME ?? path.join(os.homedir(), ".bosun");
}

export function loadOrCreateIdentity(home = bosunHome()): StoredIdentity {
  const file = path.join(home, "identity.json");
  if (fs.existsSync(file)) {
    const { secretKey } = JSON.parse(fs.readFileSync(file, "utf8")) as {
      secretKey: string;
    };
    return identityFromSecretKey(secretKey);
  }
  const identity = generateIdentity();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ secretKey: identity.secretKey }, null, 2),
    { mode: 0o600 },
  );
  return identity;
}

/**
 * Stable 32-byte iroh secret key for the P2P transport → stable node id, so
 * the supervisor's dial address survives restarts. Kept separate from the
 * Bosun device identity (different key, different purpose).
 */
export function loadOrCreateIrohSecret(home = bosunHome()): number[] {
  const file = path.join(home, "iroh-key.json");
  if (fs.existsSync(file)) {
    return (JSON.parse(fs.readFileSync(file, "utf8")) as { secret: number[] })
      .secret;
  }
  const secret = Array.from(randomBytes(32));
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ secret }), { mode: 0o600 });
  return secret;
}

export interface PairedDevice {
  publicKey: string;
  name: string;
  platform: string;
  pairedAt: number;
  expoPushToken?: string;
}

export class DeviceAllowlist {
  private devices: PairedDevice[] = [];
  private readonly file: string;

  constructor(home = bosunHome()) {
    this.file = path.join(home, "devices.json");
    if (fs.existsSync(this.file)) {
      this.devices = JSON.parse(
        fs.readFileSync(this.file, "utf8"),
      ) as PairedDevice[];
    }
  }

  has(publicKey: string): boolean {
    return this.devices.some((d) => d.publicKey === publicKey);
  }

  add(device: Omit<PairedDevice, "pairedAt">): void {
    if (this.has(device.publicKey)) return;
    this.devices.push({ ...device, pairedAt: Date.now() });
    this.save();
  }

  setPushToken(publicKey: string, expoPushToken: string): boolean {
    const device = this.devices.find((d) => d.publicKey === publicKey);
    if (!device) return false;
    device.expoPushToken = expoPushToken;
    this.save();
    return true;
  }

  pushTokens(): string[] {
    return this.devices
      .map((d) => d.expoPushToken)
      .filter((t): t is string => t !== undefined);
  }

  all(): PairedDevice[] {
    return [...this.devices];
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.devices, null, 2));
  }
}
