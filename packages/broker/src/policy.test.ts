import { describe, expect, it } from "vitest";
import type { ToolRequest } from "@bosun/protocol";
import { StarterPolicy } from "./policy.js";
import { checkHardFloor } from "./hard-floor-rules.js";

const CWD = "/Users/me/project";

function req(toolName: string, input: Record<string, unknown>): ToolRequest {
  return {
    sessionId: "s1",
    toolUseId: "t1",
    toolName,
    input,
    cwd: CWD,
    requestedAt: Date.now(),
  };
}

const policy = new StarterPolicy();

describe("StarterPolicy", () => {
  it("allows file reads", () => {
    expect(policy.evaluate(req("Read", { file_path: "/etc/hosts" })).kind).toBe(
      "allow",
    );
    expect(policy.evaluate(req("Grep", { pattern: "x" })).kind).toBe("allow");
  });

  it("allows in-workspace edits", () => {
    const d = policy.evaluate(
      req("Edit", { file_path: `${CWD}/src/index.ts` }),
    );
    expect(d.kind).toBe("allow");
  });

  it("allows relative-path edits resolved inside the workspace", () => {
    expect(policy.evaluate(req("Write", { file_path: "src/a.ts" })).kind).toBe(
      "allow",
    );
  });

  it("denies writes outside the workspace", () => {
    const d = policy.evaluate(req("Write", { file_path: "/Users/me/.zshrc" }));
    expect(d.kind).toBe("deny");
  });

  it("denies path-traversal writes that escape the workspace", () => {
    const d = policy.evaluate(
      req("Edit", { file_path: `${CWD}/../other/file.ts` }),
    );
    expect(d.kind).toBe("deny");
  });

  it("escalates plain shell commands", () => {
    const d = policy.evaluate(req("Bash", { command: "npm test" }));
    expect(d.kind).toBe("escalate");
  });

  it("escalates non-push git commands", () => {
    const d = policy.evaluate(req("Bash", { command: "git status" }));
    expect(d).toEqual({ kind: "escalate", reason: "shell command touches git" });
  });

  it("denies git push in any position", () => {
    for (const cmd of [
      "git push",
      "git push --force origin main",
      "cd /tmp && git push",
      "git -C /x push",
    ]) {
      expect(policy.evaluate(req("Bash", { command: cmd })).kind).toBe("deny");
    }
  });

  it("denies sudo", () => {
    expect(
      policy.evaluate(req("Bash", { command: "sudo rm -rf /tmp/x" })).kind,
    ).toBe("deny");
    expect(
      policy.evaluate(req("Bash", { command: "ls && sudo reboot" })).kind,
    ).toBe("deny");
  });

  it("denies recursive deletes outside the workspace", () => {
    expect(
      policy.evaluate(req("Bash", { command: "rm -rf /Users/me/other" })).kind,
    ).toBe("deny");
    expect(
      policy.evaluate(req("Bash", { command: "rm -rf ~/Documents" })).kind,
    ).toBe("deny");
  });

  it("allows recursive deletes inside the workspace via escalation", () => {
    // In-workspace rm -rf is not hard-floor blocked, but Bash still escalates.
    expect(
      policy.evaluate(req("Bash", { command: "rm -rf node_modules" })).kind,
    ).toBe("escalate");
  });

  it("escalates unknown tools", () => {
    expect(policy.evaluate(req("SomeNewTool", {})).kind).toBe("escalate");
  });
});

describe("checkHardFloor", () => {
  it("does not consult tool names it does not know for paths", () => {
    expect(checkHardFloor("Read", { file_path: "/etc/passwd" }, CWD)).toEqual({
      blocked: false,
    });
  });

  it("blocks writes to protected system paths even inside a weird cwd", () => {
    const v = checkHardFloor("Write", { file_path: "/etc/hosts" }, "/");
    expect(v.blocked).toBe(true);
  });

  it("fails closed on writing tools with no recognizable path", () => {
    const v = checkHardFloor("Write", {}, CWD);
    expect(v.blocked).toBe(true);
  });
});
