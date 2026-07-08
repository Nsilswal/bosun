import { z } from "zod";

/**
 * Normalized agent events. The supervisor maps raw Claude Agent SDK messages
 * onto these; clients never see SDK types.
 */

export const SessionStatusSchema = z.enum([
  "starting",
  "running",
  "awaiting_permission",
  "idle",
  "error",
  "exited",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const AgentEventSchema = z.discriminatedUnion("kind", [
  /** Session-level metadata, emitted once the SDK reports init. */
  z.object({
    kind: z.literal("init"),
    sessionId: z.string(),
    model: z.string(),
    cwd: z.string(),
  }),
  /** A complete assistant text block. */
  z.object({
    kind: z.literal("assistant_text"),
    text: z.string(),
  }),
  /** The agent invoked a tool. */
  z.object({
    kind: z.literal("tool_use"),
    toolUseId: z.string(),
    toolName: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  /** Result of a tool call (truncated by the supervisor for transport). */
  z.object({
    kind: z.literal("tool_result"),
    toolUseId: z.string(),
    isError: z.boolean(),
    summary: z.string(),
  }),
  /** A user/driver prompt that was sent to the agent (echoed to all clients). */
  z.object({
    kind: z.literal("user_prompt"),
    text: z.string(),
  }),
  /** Status transitions: running → awaiting_permission → running → idle ... */
  z.object({
    kind: z.literal("status"),
    status: SessionStatusSchema,
    detail: z.string().optional(),
  }),
  /** Final result of a turn, including cost/duration when the SDK reports them. */
  z.object({
    kind: z.literal("turn_complete"),
    durationMs: z.number().optional(),
    costUsd: z.number().optional(),
    isError: z.boolean(),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

/** An event with its position in the session's ordered log (for replay). */
export const SequencedEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  at: z.number(),
  event: AgentEventSchema,
});
export type SequencedEvent = z.infer<typeof SequencedEventSchema>;
