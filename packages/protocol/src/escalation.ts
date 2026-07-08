import { z } from "zod";
import { ToolRequestSchema } from "./tool-request.js";

export const EscalationDecisionSchema = z.enum(["approve", "deny"]);
export type EscalationDecision = z.infer<typeof EscalationDecisionSchema>;

export const EscalationResolutionSchema = z.enum([
  "approved",
  "denied",
  "expired",
]);
export type EscalationResolution = z.infer<typeof EscalationResolutionSchema>;

export const PendingEscalationSchema = z.object({
  id: z.string(),
  request: ToolRequestSchema,
  /** Why the policy escalated instead of deciding. */
  reason: z.string(),
  createdAt: z.number(),
  /** After this the queue resolves the escalation as expired (deny). */
  expiresAt: z.number(),
});
export type PendingEscalation = z.infer<typeof PendingEscalationSchema>;

export const ResolvedEscalationSchema = z.object({
  id: z.string(),
  resolution: EscalationResolutionSchema,
  /** Public key of the deciding device; absent when expired. */
  resolvedBy: z.string().optional(),
  resolvedAt: z.number(),
});
export type ResolvedEscalation = z.infer<typeof ResolvedEscalationSchema>;
