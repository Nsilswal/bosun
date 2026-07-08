import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Exercise the compiled hook script exactly as Claude Code invokes it:
 * payload on stdin, verdict as exit code. Requires `pnpm build` first
 * (dist/ is what actually ships), so the test builds paths off dist.
 */
const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../dist/hooks/hard-floor.js",
);

function runHook(payload: unknown): { code: number; stderr: string } {
  try {
    execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, stderr: "" };
  } catch (err) {
    const e = err as { status: number | null; stderr: Buffer };
    return { code: e.status ?? -1, stderr: e.stderr.toString() };
  }
}

const base = {
  session_id: "s1",
  cwd: "/Users/me/project",
  hook_event_name: "PreToolUse",
};

describe("hard-floor hook script", () => {
  it("exits 0 for a safe read", () => {
    const r = runHook({
      ...base,
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/a.ts" },
    });
    expect(r.code).toBe(0);
  });

  it("exits 2 for git push", () => {
    const r = runHook({
      ...base,
      tool_name: "Bash",
      tool_input: { command: "git push origin main" },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no-git-push");
  });

  it("exits 2 for writes outside the workspace", () => {
    const r = runHook({
      ...base,
      tool_name: "Write",
      tool_input: { file_path: "/Users/me/.ssh/config", content: "x" },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no-write-outside-workspace");
  });

  it("exits 2 (fails closed) on garbage stdin", () => {
    try {
      execFileSync(process.execPath, [HOOK], {
        input: "not json",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect.unreachable("hook should have exited non-zero");
    } catch (err) {
      expect((err as { status: number }).status).toBe(2);
    }
  });

  it("exits 2 on a payload missing cwd", () => {
    const r = runHook({ tool_name: "Bash", tool_input: { command: "ls" } });
    expect(r.code).toBe(2);
  });
});
