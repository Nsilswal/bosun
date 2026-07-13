import { randomBytes } from "node:crypto";

/** Single-use, time-limited pairing tokens (proof of QR possession). */
export class PairingManager {
  private tokens = new Map<string, number>(); // token → expiresAt

  constructor(private readonly now: () => number = Date.now) {}

  issue(ttlMs: number): { token: string; expiresAt: number } {
    // Opportunistically drop expired tokens so the map can't grow unbounded
    // across many pairing sessions.
    this.prune();
    const token = randomBytes(16).toString("base64url");
    const expiresAt = this.now() + ttlMs;
    this.tokens.set(token, expiresAt);
    return { token, expiresAt };
  }

  /** Consumes the token: a token pairs exactly one device. */
  redeem(token: string): boolean {
    const expiresAt = this.tokens.get(token);
    if (expiresAt === undefined) return false;
    this.tokens.delete(token);
    return this.now() <= expiresAt;
  }

  /** Number of live (unredeemed, unexpired) tokens — for observability/tests. */
  pending(): number {
    this.prune();
    return this.tokens.size;
  }

  private prune(): void {
    const t = this.now();
    for (const [token, expiresAt] of this.tokens) {
      if (t > expiresAt) this.tokens.delete(token);
    }
  }
}
