import { z } from "zod";

/**
 * A tool call the agent wants to make, as seen by the permission layer.
 * This is the unit the PolicyEngine evaluates and the app renders on
 * escalation cards.
 */
export const ToolRequestSchema = z.object({
  sessionId: z.string(),
  toolUseId: z.string(),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  /** Workspace the session is rooted in; policy rules are relative to this. */
  cwd: z.string(),
  requestedAt: z.number(),
});

export type ToolRequest = z.infer<typeof ToolRequestSchema>;
