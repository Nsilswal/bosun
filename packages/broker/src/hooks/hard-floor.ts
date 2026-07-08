#!/usr/bin/env node
/**
 * Bosun hard-floor PreToolUse hook.
 *
 * Reads the Claude Code hook payload from stdin and blocks never-cross tool
 * calls by exiting with code 2 — the only exit code Claude Code treats as
 * blocking for PreToolUse (exit 1 is a NON-blocking error and the tool call
 * would proceed). Any internal failure therefore also exits 2: fail closed.
 *
 * Installed via settings:
 *   { "hooks": { "PreToolUse": [ { "hooks": [
 *       { "type": "command", "command": "bosun-hard-floor" } ] } ] } }
 */
import { checkHardFloor } from "../hard-floor-rules.js";

function fail(reason: string): never {
  process.stderr.write(`bosun hard floor: ${reason}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    tool_name?: unknown;
    tool_input?: unknown;
    cwd?: unknown;
  };

  const toolName = payload.tool_name;
  const cwd = payload.cwd;
  const input = payload.tool_input;
  if (typeof toolName !== "string" || typeof cwd !== "string") {
    fail("malformed hook payload (missing tool_name or cwd)");
  }

  const verdict = checkHardFloor(
    toolName,
    (input ?? {}) as Record<string, unknown>,
    cwd,
  );
  if (verdict.blocked) {
    fail(`${verdict.reason} [rule: ${verdict.rule}]`);
  }
  process.exit(0);
}

main().catch((err) => {
  fail(`hook error (failing closed): ${String(err)}`);
});
