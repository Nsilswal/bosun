import type { ToolRequest } from "@bosun/protocol";
import type { PermissionBroker } from "../broker.js";

/**
 * Structural match for the Claude Agent SDK's `CanUseTool` callback and
 * `PermissionResult` — declared here so the broker package doesn't depend on
 * the SDK. The supervisor assigns the returned function to `canUseTool`
 * directly; TypeScript checks compatibility at that assignment.
 */
export type CanUseToolResult =
  | {
      behavior: "allow";
      updatedInput: Record<string, unknown>;
    }
  | {
      behavior: "deny";
      message: string;
    };

export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: { toolUseID: string },
) => Promise<CanUseToolResult>;

/**
 * Bridge the SDK permission callback onto the broker. `session` supplies the
 * context the callback signature lacks. NOTE: canUseTool is only invoked when
 * permission evaluation falls through to a prompt — sessions must run without
 * allow-rules or the broker is silently bypassed.
 */
export function asCanUseTool(
  broker: PermissionBroker,
  session: { sessionId: () => string; cwd: string },
): CanUseToolFn {
  return async (toolName, input, { toolUseID }) => {
    const req: ToolRequest = {
      sessionId: session.sessionId(),
      toolUseId: toolUseID,
      toolName,
      input,
      cwd: session.cwd,
      requestedAt: Date.now(),
    };
    const result = await broker.decide(req);
    return result.behavior === "allow"
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: result.reason };
  };
}
