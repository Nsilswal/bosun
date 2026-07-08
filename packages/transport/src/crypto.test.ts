import { describe, expect, it } from "vitest";
import {
  acceptHello,
  acceptWelcome,
  createHello,
  fromB64Url,
  generateIdentity,
  identityFromSecretKey,
  toB64Url,
} from "./crypto.js";

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    for (const len of [0, 1, 2, 3, 4, 31, 32, 33, 64, 100]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + len) % 256);
      expect(fromB64Url(toB64Url(bytes))).toEqual(bytes);
    }
  });

  it("produces url-safe output", () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(toB64Url(bytes)).not.toMatch(/[+/=]/);
  });
});

describe("identity", () => {
  it("persists via secret key", () => {
    const a = generateIdentity();
    const b = identityFromSecretKey(a.secretKey);
    expect(b.publicKey).toBe(a.publicKey);
  });
});

describe("handshake", () => {
  it("completes mutually and encrypts both directions", () => {
    const device = generateIdentity();
    const server = generateIdentity();

    const hello = createHello(device);
    const accepted = acceptHello(hello.message, server);
    expect(accepted).not.toBeNull();
    expect(accepted!.session.peerPublicKey).toBe(device.publicKey);

    const clientSession = acceptWelcome(
      accepted!.message,
      hello.message,
      hello.state,
      server.publicKey,
    );
    expect(clientSession).not.toBeNull();
    expect(clientSession!.peerPublicKey).toBe(server.publicKey);

    const frame = clientSession!.seal({ hi: "supervisor" });
    expect(accepted!.session.open(frame)).toEqual({ hi: "supervisor" });
    const reply = accepted!.session.seal({ hi: "device" });
    expect(clientSession!.open(reply)).toEqual({ hi: "device" });
  });

  it("rejects a forged hello signature", () => {
    const device = generateIdentity();
    const server = generateIdentity();
    const hello = createHello(device);
    const forged = { ...hello.message, nonce: toB64Url(new Uint8Array(16)) };
    expect(acceptHello(forged, server)).toBeNull();
  });

  it("rejects a welcome signed by an unexpected server key", () => {
    const device = generateIdentity();
    const realServer = generateIdentity();
    const impostor = generateIdentity();

    const hello = createHello(device);
    const accepted = acceptHello(hello.message, impostor)!;
    expect(
      acceptWelcome(
        accepted.message,
        hello.message,
        hello.state,
        realServer.publicKey,
      ),
    ).toBeNull();
  });

  it("drops tampered frames", () => {
    const device = generateIdentity();
    const server = generateIdentity();
    const hello = createHello(device);
    const accepted = acceptHello(hello.message, server)!;
    const clientSession = acceptWelcome(
      accepted.message,
      hello.message,
      hello.state,
    )!;

    const frame = JSON.parse(clientSession.seal({ secret: 42 })) as {
      n: string;
      c: string;
    };
    const cipher = fromB64Url(frame.c);
    cipher[0] = cipher[0]! ^ 0xff;
    const tampered = JSON.stringify({ n: frame.n, c: toB64Url(cipher) });
    expect(accepted.session.open(tampered)).toBeNull();
    expect(accepted.session.open("garbage")).toBeNull();
  });
});
