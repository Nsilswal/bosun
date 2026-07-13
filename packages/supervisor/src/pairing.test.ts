import { describe, expect, it } from "vitest";
import { PairingManager } from "./pairing.js";

describe("PairingManager", () => {
  it("redeems a valid token exactly once", () => {
    const pm = new PairingManager();
    const { token } = pm.issue(60_000);
    expect(pm.redeem(token)).toBe(true);
    expect(pm.redeem(token)).toBe(false); // single-use
  });

  it("rejects unknown tokens", () => {
    const pm = new PairingManager();
    expect(pm.redeem("nope")).toBe(false);
  });

  it("rejects an expired token", () => {
    let now = 1000;
    const pm = new PairingManager(() => now);
    const { token } = pm.issue(5000);
    now = 6001;
    expect(pm.redeem(token)).toBe(false);
  });

  it("prunes expired tokens so the map doesn't grow unbounded", () => {
    let now = 0;
    const pm = new PairingManager(() => now);
    for (let i = 0; i < 100; i++) {
      pm.issue(1000); // each expires at now+1000
      now += 10; // tokens issued across time
    }
    // Advance well past every token's expiry; the next issue() prunes them.
    now += 10_000;
    pm.issue(1000);
    expect(pm.pending()).toBe(1);
  });
});
