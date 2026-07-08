import type { ToolRequest } from "@bosun/protocol";
import { checkHardFloor } from "./hard-floor-rules.js";

export type PolicyDecision =
  | { kind: "allow"; rule: string }
  | { kind: "deny"; rule: string; reason: string }
  | { kind: "escalate"; reason: string };

export interface PolicyEngine {
  evaluate(req: ToolRequest): PolicyDecision;
}

/** Read-only tools that never mutate anything. */
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "NotebookRead"]);

/** In-workspace mutations, allowed once the hard floor confirms the path. */
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Agent-internal bookkeeping with no external effect. */
const INTERNAL_TOOLS = new Set(["TodoWrite", "Task", "ExitPlanMode"]);

const GIT_RE = /\bgit\b/;

/**
 * Starter policy:
 *  - hard-floor violations → deny (mirrors what the hook would block, so the
 *    denial happens here with a clean message instead of via exit-2)
 *  - file reads and in-workspace edits → allow
 *  - Bash and anything touching git → escalate
 *  - everything unrecognized → escalate (fail toward a human)
 */
export class StarterPolicy implements PolicyEngine {
  evaluate(req: ToolRequest): PolicyDecision {
    const floor = checkHardFloor(req.toolName, req.input, req.cwd);
    if (floor.blocked) {
      return { kind: "deny", rule: floor.rule, reason: floor.reason };
    }

    if (READ_TOOLS.has(req.toolName) || INTERNAL_TOOLS.has(req.toolName)) {
      return { kind: "allow", rule: "read-only-or-internal" };
    }

    if (EDIT_TOOLS.has(req.toolName)) {
      // Hard floor already verified the path is inside the workspace.
      return { kind: "allow", rule: "in-workspace-edit" };
    }

    if (req.toolName === "Bash") {
      const command = typeof req.input.command === "string" ? req.input.command : "";
      const reason = GIT_RE.test(command)
        ? "shell command touches git"
        : "shell commands require approval";
      return { kind: "escalate", reason };
    }

    return {
      kind: "escalate",
      reason: `no policy rule for tool ${req.toolName}`,
    };
  }
}
