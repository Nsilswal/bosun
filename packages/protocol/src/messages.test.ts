import { describe, expect, it } from "vitest";
import {
  EnvelopeSchema,
  PROTOCOL_VERSION,
  QrPayloadSchema,
  PreAuthMessageSchema,
} from "./index.js";

describe("protocol schemas", () => {
  it("round-trips a client envelope", () => {
    const env = {
      v: PROTOCOL_VERSION,
      id: "m1",
      msg: {
        type: "escalation.decide",
        escalationId: "esc-1",
        decision: "approve",
      },
    };
    expect(EnvelopeSchema.parse(JSON.parse(JSON.stringify(env)))).toEqual(env);
  });

  it("round-trips a server agent.event envelope", () => {
    const env = {
      v: PROTOCOL_VERSION,
      id: "m2",
      re: "m1",
      msg: {
        type: "agent.event",
        sessionId: "s1",
        event: {
          seq: 3,
          at: 1720000000000,
          event: {
            kind: "tool_use",
            toolUseId: "t1",
            toolName: "Bash",
            input: { command: "ls" },
          },
        },
      },
    };
    expect(EnvelopeSchema.parse(JSON.parse(JSON.stringify(env)))).toEqual(env);
  });

  it("rejects unknown message types", () => {
    const bad = { v: PROTOCOL_VERSION, id: "m3", msg: { type: "nope" } };
    expect(EnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects wrong protocol versions", () => {
    const bad = { v: 99, id: "m4", msg: { type: "ping" } };
    expect(EnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it("parses a QR payload and rejects foreign QR codes", () => {
    const qr = {
      bosun: 1,
      name: "laptop",
      addrs: [{ host: "192.168.1.10", port: 4180 }],
      supervisorPublicKey: "pk",
      pairingToken: "tok",
      expiresAt: 1720000000000,
    };
    expect(QrPayloadSchema.parse(qr)).toEqual(qr);
    expect(QrPayloadSchema.safeParse({ hello: "world" }).success).toBe(false);
  });

  it("parses handshake messages via the pre-auth union", () => {
    const hello = {
      type: "hs.hello",
      devicePublicKey: "dpk",
      ephemeralPublicKey: "epk",
      nonce: "n",
      signature: "sig",
    };
    expect(PreAuthMessageSchema.parse(hello)).toEqual(hello);
  });
});
