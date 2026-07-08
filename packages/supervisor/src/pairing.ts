import { randomBytes } from "node:crypto";

/** Single-use, time-limited pairing tokens (proof of QR possession). */
export class PairingManager {
  private tokens = new Map<string, number>(); // token → expiresAt

  issue(ttlMs: number): { token: string; expiresAt: number } {
    const token = randomBytes(16).toString("base64url");
    const expiresAt = Date.now() + ttlMs;
    this.tokens.set(token, expiresAt);
    return { token, expiresAt };
  }

  /** Consumes the token: a token pairs exactly one device. */
  redeem(token: string): boolean {
    const expiresAt = this.tokens.get(token);
    if (expiresAt === undefined) return false;
    this.tokens.delete(token);
    return Date.now() <= expiresAt;
  }
}
