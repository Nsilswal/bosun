import { z } from "zod";
import { SequencedEventSchema, SessionStatusSchema } from "./events.js";
import {
  EscalationDecisionSchema,
  PendingEscalationSchema,
  ResolvedEscalationSchema,
} from "./escalation.js";

/**
 * Post-authentication protocol messages. Every frame on an authenticated
 * connection is one `Envelope`; `re` correlates a reply with its request id.
 */

export const PROTOCOL_VERSION = 1;

const SessionSummarySchema = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  status: SessionStatusSchema,
  lastActivityAt: z.number(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

// ── client → supervisor ────────────────────────────────────────────────────

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.list") }),
  z.object({
    type: z.literal("session.attach"),
    sessionId: z.string(),
    /** Replay events with seq > sinceSeq; omit for full snapshot. */
    sinceSeq: z.number().int().optional(),
  }),
  z.object({
    type: z.literal("prompt.send"),
    sessionId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("agent.interrupt"),
    sessionId: z.string(),
  }),
  /** Spawn a new agent session. cwd defaults to the supervisor's workspace. */
  z.object({
    type: z.literal("session.start"),
    cwd: z.string().optional(),
    /**
     * Model alias for the agent (e.g. "opus", "sonnet", "haiku"). Omit to use
     * the supervisor machine's configured default. See MODEL_OPTIONS.
     */
    model: z.string().optional(),
  }),
  z.object({
    type: z.literal("session.stop"),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal("escalation.decide"),
    escalationId: z.string(),
    decision: EscalationDecisionSchema,
  }),
  /** Register this device's Expo push token for escalation nudges. */
  z.object({
    type: z.literal("push.register"),
    expoPushToken: z.string(),
  }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ── supervisor → client ────────────────────────────────────────────────────

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.list.result"),
    sessions: z.array(SessionSummarySchema),
  }),
  z.object({
    type: z.literal("session.snapshot"),
    sessionId: z.string(),
    status: SessionStatusSchema,
    cwd: z.string(),
    events: z.array(SequencedEventSchema),
    pendingEscalations: z.array(PendingEscalationSchema),
  }),
  /** Live event stream after attach. */
  z.object({
    type: z.literal("agent.event"),
    sessionId: z.string(),
    event: SequencedEventSchema,
  }),
  z.object({
    type: z.literal("escalation.new"),
    sessionId: z.string(),
    escalation: PendingEscalationSchema,
  }),
  z.object({
    type: z.literal("escalation.resolved"),
    sessionId: z.string(),
    result: ResolvedEscalationSchema,
  }),
  z.object({ type: z.literal("ok") }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
  }),
  z.object({ type: z.literal("pong") }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ── envelope ───────────────────────────────────────────────────────────────

export const EnvelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  /** Unique per message; replies reference it via `re`. */
  id: z.string(),
  re: z.string().optional(),
  msg: z.union([ClientMessageSchema, ServerMessageSchema]),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export type ProtocolMessage = ClientMessage | ServerMessage;
