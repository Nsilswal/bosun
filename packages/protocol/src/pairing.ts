import { z } from "zod";

/**
 * Pairing and connection handshake schemas.
 *
 * The QR payload travels out-of-band (rendered in the supervisor's terminal,
 * scanned by the app). Possession of the single-use pairing token proves
 * physical proximity, so pairing completes without a second confirmation.
 *
 * All keys are base64url-encoded raw Ed25519/X25519 public keys.
 */

export const QrPayloadSchema = z.object({
  /** Discriminator so the app can reject non-Bosun QR codes. */
  bosun: z.literal(1),
  name: z.string(),
  /** Candidate addresses, tried in order. */
  addrs: z.array(z.object({ host: z.string(), port: z.number().int() })),
  supervisorPublicKey: z.string(),
  pairingToken: z.string(),
  expiresAt: z.number(),
});
export type QrPayload = z.infer<typeof QrPayloadSchema>;

export const PairRequestSchema = z.object({
  type: z.literal("pair.request"),
  pairingToken: z.string(),
  devicePublicKey: z.string(),
  deviceName: z.string(),
  platform: z.enum(["ios", "android", "cli", "other"]),
});
export type PairRequest = z.infer<typeof PairRequestSchema>;

export const PairOkSchema = z.object({
  type: z.literal("pair.ok"),
  supervisorName: z.string(),
  supervisorPublicKey: z.string(),
});
export type PairOk = z.infer<typeof PairOkSchema>;

export const PairErrorSchema = z.object({
  type: z.literal("pair.error"),
  message: z.string(),
});
export type PairError = z.infer<typeof PairErrorSchema>;

/**
 * Connection handshake (every connection, post-pairing).
 *
 *   client → server  hs.hello   (client identity + ephemeral key + signature)
 *   server → client  hs.welcome (server proof + ephemeral key)
 *
 * Both sides sign the transcript (both ephemeral public keys + nonces) with
 * their static Ed25519 key, proving identity; X25519 session keys are then
 * derived from the ephemerals and all subsequent frames are sealed.
 */
export const HandshakeHelloSchema = z.object({
  type: z.literal("hs.hello"),
  devicePublicKey: z.string(),
  ephemeralPublicKey: z.string(),
  nonce: z.string(),
  /** sign(devicePriv, ephemeralPublicKey || nonce) */
  signature: z.string(),
});
export type HandshakeHello = z.infer<typeof HandshakeHelloSchema>;

export const HandshakeWelcomeSchema = z.object({
  type: z.literal("hs.welcome"),
  supervisorPublicKey: z.string(),
  ephemeralPublicKey: z.string(),
  nonce: z.string(),
  /** sign(supervisorPriv, clientEphemeral || clientNonce || serverEphemeral || serverNonce) */
  signature: z.string(),
});
export type HandshakeWelcome = z.infer<typeof HandshakeWelcomeSchema>;

export const HandshakeRejectSchema = z.object({
  type: z.literal("hs.reject"),
  message: z.string(),
});
export type HandshakeReject = z.infer<typeof HandshakeRejectSchema>;

/** Everything that may travel on a connection before it is authenticated. */
export const PreAuthMessageSchema = z.discriminatedUnion("type", [
  PairRequestSchema,
  PairOkSchema,
  PairErrorSchema,
  HandshakeHelloSchema,
  HandshakeWelcomeSchema,
  HandshakeRejectSchema,
]);
export type PreAuthMessage = z.infer<typeof PreAuthMessageSchema>;
