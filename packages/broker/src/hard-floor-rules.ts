import path from "node:path";
import os from "node:os";

/**
 * The deterministic hard floor: never-cross rules enforced by the PreToolUse
 * hook (exit 2) regardless of model judgment or policy configuration. The
 * PolicyEngine also consults these so denials happen at the cheapest layer,
 * but the hook is the backstop — it holds even if every other layer is
 * compromised or misconfigured.
 *
 * Everything here must be pure and synchronous: auditable at a glance.
 */

export type HardFloorVerdict =
  | { blocked: false }
  | { blocked: true; rule: string; reason: string };

const FILE_PATH_KEYS = ["file_path", "path", "notebook_path"] as const;

/** Tools that write to the filesystem via a path argument. */
const WRITING_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

/** Paths no agent may delete or write, workspace or not. */
const PROTECTED_PREFIXES = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/Library",
];

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveAgainst(cwd: string, p: string): string {
  const expanded = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
  return path.resolve(cwd, expanded);
}

function extractWritePath(
  input: Record<string, unknown>,
): string | undefined {
  for (const key of FILE_PATH_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** `git push` anywhere in a shell command (incl. `&&` chains), any flags. */
const GIT_PUSH_RE = /\bgit\b(?:\s+\S+)*?\s+push\b/;

/** `rm` with a recursive and/or force flag, in short or long form. */
const RM_FORCE_RE =
  /\brm\b(?=[^|;&]*(?:\s-[a-zA-Z]*[rRf][a-zA-Z]*\b|\s--(?:recursive|force)\b))/;

const SUDO_RE = /(?:^|[;&|]\s*)sudo\b/;

export function checkBashCommand(
  command: string,
  cwd: string,
): HardFloorVerdict {
  if (SUDO_RE.test(command)) {
    return {
      blocked: true,
      rule: "no-sudo",
      reason: "sudo is never allowed",
    };
  }
  if (GIT_PUSH_RE.test(command)) {
    return {
      blocked: true,
      rule: "no-git-push",
      reason: "git push is never allowed from an agent",
    };
  }
  if (RM_FORCE_RE.test(command)) {
    // Recursive/forced deletes: only tolerated on relative paths that stay
    // inside the workspace. Any absolute path, tilde, or parent traversal
    // in the rm argument list blocks.
    const args = command
      .slice(command.search(/\brm\b/) + 2)
      .split(/[|;&]/, 1)[0]!
      .trim()
      .split(/\s+/)
      .filter((a) => a.length > 0 && !a.startsWith("-"));
    for (const arg of args) {
      const target = resolveAgainst(cwd, arg.replace(/^['"]|['"]$/g, ""));
      if (!isInside(cwd, target)) {
        return {
          blocked: true,
          rule: "no-delete-outside-workspace",
          reason: `refusing to delete ${arg} (outside the workspace)`,
        };
      }
      if (PROTECTED_PREFIXES.some((p) => isInside(p, target))) {
        return {
          blocked: true,
          rule: "no-delete-protected-path",
          reason: `refusing to delete ${arg} (protected path)`,
        };
      }
    }
  }
  return { blocked: false };
}

/**
 * Evaluate the hard floor for a tool call. `cwd` is the session workspace;
 * writes must stay inside it.
 */
export function checkHardFloor(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): HardFloorVerdict {
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return checkBashCommand(command, cwd);
  }

  if (WRITING_TOOLS.has(toolName)) {
    const rawPath = extractWritePath(input);
    if (rawPath === undefined) {
      return {
        blocked: true,
        rule: "write-without-path",
        reason: `${toolName} call missing a recognizable path argument`,
      };
    }
    const target = resolveAgainst(cwd, rawPath);
    if (!isInside(cwd, target)) {
      return {
        blocked: true,
        rule: "no-write-outside-workspace",
        reason: `refusing to write ${rawPath} (outside the workspace ${cwd})`,
      };
    }
    if (PROTECTED_PREFIXES.some((p) => isInside(p, target))) {
      return {
        blocked: true,
        rule: "no-write-protected-path",
        reason: `refusing to write ${rawPath} (protected path)`,
      };
    }
  }

  return { blocked: false };
}
