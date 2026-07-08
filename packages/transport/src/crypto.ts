/**
 * Environment-agnostic crypto for Bosun transports: pure tweetnacl + pure-JS
 * base64url. No Node imports — this module must run unchanged in React Native
 * (Hermes) and Node, so both ends execute the exact same handshake code.
 *
 * Identity:  Ed25519 (signing).  Session: ephemeral X25519 → XSalsa20-Poly1305.
 * Handshake: mutual challenge/response — each side signs the ephemeral-key
 * transcript with its static identity key, so a MITM cannot substitute
 * ephemerals; a fresh nonce per side prevents replay.
 */
import nacl from "tweetnacl";

// ── base64url ──────────────────────────────────────────────────────────────

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64_ALPHABET.length; i++) {
  B64_LOOKUP[B64_ALPHABET[i]!] = i;
}

export function toB64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += B64_ALPHABET[b0 >> 2]!;
    out += B64_ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 !== undefined) out += B64_ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 !== undefined) out += B64_ALPHABET[b2 & 63]!;
  }
  return out;
}

export function fromB64Url(s: string): Uint8Array {
  const len = s.length;
  const outLen = Math.floor((len * 3) / 4);
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const c0 = B64_LOOKUP[s[i]!];
    const c1 = B64_LOOKUP[s[i + 1]!];
    const c2 = i + 2 < len ? B64_LOOKUP[s[i + 2]!] : undefined;
    const c3 = i + 3 < len ? B64_LOOKUP[s[i + 3]!] : undefined;
    if (c0 === undefined || c1 === undefined) throw new Error("bad base64url");
    out[o++] = (c0 << 2) | (c1 >> 4);
    if (c2 !== undefined) out[o++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (c3 !== undefined) out[o++] = ((c2! & 3) << 6) | c3;
  }
  return out;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ── identity ───────────────────────────────────────────────────────────────

export interface Identity {
  /** base64url Ed25519 public key — the device's stable id. */
  publicKey: string;
  sign(data: Uint8Array): Uint8Array;
}

export interface StoredIdentity extends Identity {
  /** base64url Ed25519 secret key, for persistence. Guard accordingly. */
  secretKey: string;
}

export function generateIdentity(): StoredIdentity {
  const kp = nacl.sign.keyPair();
  return identityFromSecretKey(toB64Url(kp.secretKey));
}

export function identityFromSecretKey(secretKeyB64: string): StoredIdentity {
  const secretKey = fromB64Url(secretKeyB64);
  const kp = nacl.sign.keyPair.fromSecretKey(secretKey);
  return {
    publicKey: toB64Url(kp.publicKey),
    secretKey: secretKeyB64,
    sign: (data) => nacl.sign.detached(data, secretKey),
  };
}

// ── handshake ──────────────────────────────────────────────────────────────

export interface SessionCrypto {
  /** The authenticated static public key of the peer. */
  peerPublicKey: string;
  seal(obj: unknown): string;
  /** Returns null when authentication fails. */
  open(frame: string): unknown | null;
}

interface HelloState {
  ephemeralSecret: Uint8Array;
  ephemeralPublicKey: string;
  nonce: string;
}

export interface HelloMessage {
  type: "hs.hello";
  devicePublicKey: string;
  ephemeralPublicKey: string;
  nonce: string;
  signature: string;
}

export interface WelcomeMessage {
  type: "hs.welcome";
  supervisorPublicKey: string;
  ephemeralPublicKey: string;
  nonce: string;
  signature: string;
}

function helloTranscript(eph: string, nonce: string): Uint8Array {
  return concat(fromB64Url(eph), fromB64Url(nonce));
}

function welcomeTranscript(hello: HelloMessage, eph: string, nonce: string): Uint8Array {
  return concat(
    fromB64Url(hello.ephemeralPublicKey),
    fromB64Url(hello.nonce),
    fromB64Url(eph),
    fromB64Url(nonce),
  );
}

export function createHello(identity: Identity): {
  message: HelloMessage;
  state: HelloState;
} {
  const eph = nacl.box.keyPair();
  const ephB64 = toB64Url(eph.publicKey);
  const nonce = toB64Url(nacl.randomBytes(16));
  return {
    message: {
      type: "hs.hello",
      devicePublicKey: identity.publicKey,
      ephemeralPublicKey: ephB64,
      nonce,
      signature: toB64Url(identity.sign(helloTranscript(ephB64, nonce))),
    },
    state: { ephemeralSecret: eph.secretKey, ephemeralPublicKey: ephB64, nonce },
  };
}

/**
 * Server side: verify the hello signature and produce the welcome + session.
 * Returns null when the signature doesn't verify — callers must drop the
 * connection (allowlist checks are the caller's job; this only authenticates).
 */
export function acceptHello(
  hello: HelloMessage,
  serverIdentity: Identity,
): { message: WelcomeMessage; session: SessionCrypto } | null {
  const ok = nacl.sign.detached.verify(
    helloTranscript(hello.ephemeralPublicKey, hello.nonce),
    fromB64Url(hello.signature),
    fromB64Url(hello.devicePublicKey),
  );
  if (!ok) return null;

  const eph = nacl.box.keyPair();
  const ephB64 = toB64Url(eph.publicKey);
  const nonce = toB64Url(nacl.randomBytes(16));
  const shared = nacl.box.before(
    fromB64Url(hello.ephemeralPublicKey),
    eph.secretKey,
  );
  return {
    message: {
      type: "hs.welcome",
      supervisorPublicKey: serverIdentity.publicKey,
      ephemeralPublicKey: ephB64,
      nonce,
      signature: toB64Url(
        serverIdentity.sign(welcomeTranscript(hello, ephB64, nonce)),
      ),
    },
    session: makeSession(shared, hello.devicePublicKey),
  };
}

/**
 * Client side: verify the welcome signature (and, when the server is already
 * known, that the signing key matches) and derive the session.
 */
export function acceptWelcome(
  welcome: WelcomeMessage,
  hello: HelloMessage,
  state: HelloState,
  expectedServerPublicKey?: string,
): SessionCrypto | null {
  if (
    expectedServerPublicKey !== undefined &&
    welcome.supervisorPublicKey !== expectedServerPublicKey
  ) {
    return null;
  }
  const ok = nacl.sign.detached.verify(
    welcomeTranscript(hello, welcome.ephemeralPublicKey, welcome.nonce),
    fromB64Url(welcome.signature),
    fromB64Url(welcome.supervisorPublicKey),
  );
  if (!ok) return null;

  const shared = nacl.box.before(
    fromB64Url(welcome.ephemeralPublicKey),
    state.ephemeralSecret,
  );
  return makeSession(shared, welcome.supervisorPublicKey);
}

function makeSession(shared: Uint8Array, peerPublicKey: string): SessionCrypto {
  return {
    peerPublicKey,
    seal(obj: unknown): string {
      const nonce = nacl.randomBytes(nacl.box.nonceLength);
      const plaintext = textEncoder.encode(JSON.stringify(obj));
      const boxed = nacl.box.after(plaintext, nonce, shared);
      return JSON.stringify({ n: toB64Url(nonce), c: toB64Url(boxed) });
    },
    open(frame: string): unknown | null {
      try {
        const { n, c } = JSON.parse(frame) as { n: string; c: string };
        const opened = nacl.box.open.after(fromB64Url(c), fromB64Url(n), shared);
        if (!opened) return null;
        return JSON.parse(textDecoder.decode(opened));
      } catch {
        return null;
      }
    },
  };
}
