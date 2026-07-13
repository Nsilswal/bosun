import {
  query,
  type HookJSONOutput,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@bosun/protocol";
import { asCanUseTool, checkHardFloor } from "@bosun/broker";
import {
  AsyncQueue,
  type AgentHandle,
  type AgentRunner,
  type AgentStartOptions,
} from "./runner.js";

const TOOL_RESULT_SUMMARY_MAX = 600;

/**
 * The broker hook must be able to block for as long as an escalation can
 * stay pending (10 min default) plus margin, so give the SDK hook matcher a
 * generous timeout. Seconds, per the SDK contract.
 */
const BROKER_HOOK_TIMEOUT_S = 900;

/**
 * Claude Code via the Agent SDK, streaming-input mode (multi-turn).
 *
 * Permission wiring (see ARCHITECTURE.md): ALL gating happens in a
 * PreToolUse hook, because hooks fire for every tool call unconditionally —
 * Claude Code auto-approves some calls internally (e.g. read-only Bash), so
 * `canUseTool` alone would let those bypass the broker entirely. The hook
 * checks the deterministic hard floor first, then asks the broker, which may
 * block on a phone approval. `canUseTool` stays wired as a fallback for any
 * path that skips hooks; with the hook always answering allow/deny it should
 * never fire.
 */
export class ClaudeAgentRunner implements AgentRunner {
  start(opts: AgentStartOptions): AgentHandle {
    const input = new AsyncQueue<SDKUserMessage>();
    const events = new AsyncQueue<AgentEvent>();

    const brokerHook = async (
      hookInput: unknown,
      toolUseID: string | undefined,
    ): Promise<HookJSONOutput> => {
      const { tool_name, tool_input } = hookInput as {
        tool_name: string;
        tool_input: Record<string, unknown>;
      };
      const deny = (reason: string): HookJSONOutput => ({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      });

      const verdict = checkHardFloor(tool_name, tool_input ?? {}, opts.cwd);
      if (verdict.blocked) {
        return deny(
          `bosun hard floor: ${verdict.reason} [rule: ${verdict.rule}]`,
        );
      }

      // skip-permissions: enforce only the hard floor, never escalate — the
      // agent runs unattended past the deterministic never-cross rules.
      if (opts.skipPermissions) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: "skip-permissions: hard floor passed",
          },
        };
      }

      const result = await opts.broker.decide({
        sessionId: opts.localSessionId,
        toolUseId: toolUseID ?? "unknown",
        toolName: tool_name,
        input: tool_input ?? {},
        cwd: opts.cwd,
        requestedAt: Date.now(),
      });
      if (result.behavior === "deny") return deny(result.reason);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: result.reason,
        },
      };
    };

    const options: Options = {
      cwd: opts.cwd,
      permissionMode: opts.skipPermissions ? "bypassPermissions" : "default",
      // Don't inherit the user's settings: their allow-rules would let tools
      // skip canUseTool, and their hooks don't belong in supervised sessions.
      settingSources: [],
      canUseTool: asCanUseTool(opts.broker, {
        sessionId: () => opts.localSessionId,
        cwd: opts.cwd,
      }),
      hooks: {
        PreToolUse: [{ hooks: [brokerHook], timeout: BROKER_HOOK_TIMEOUT_S }],
      },
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.resumeProviderSessionId !== undefined
        ? { resume: opts.resumeProviderSessionId }
        : {}),
    };

    const q = query({ prompt: input, options });

    void (async () => {
      try {
        for await (const message of q) {
          for (const event of translate(message)) events.push(event);
        }
        events.push({ kind: "status", status: "exited" });
      } catch (err) {
        events.push({
          kind: "status",
          status: "error",
          detail: err instanceof Error ? err.message : String(err),
        });
      } finally {
        events.end();
      }
    })();

    return {
      events: () => events,
      send: (text: string): void => {
        events.push({ kind: "user_prompt", text });
        events.push({ kind: "status", status: "running" });
        input.push({
          type: "user",
          message: { role: "user", content: [{ type: "text", text }] },
          parent_tool_use_id: null,
        } as SDKUserMessage);
      },
      interrupt: () => q.interrupt(),
      stop: async (): Promise<void> => {
        input.end();
        await q.interrupt().catch(() => undefined);
      },
    };
  }
}

function* translate(message: SDKMessage): Generator<AgentEvent> {
  switch (message.type) {
    case "system": {
      if (message.subtype === "init") {
        yield {
          kind: "init",
          sessionId: message.session_id,
          model: message.model,
          cwd: message.cwd,
        };
        yield { kind: "status", status: "idle" };
      }
      return;
    }
    case "assistant": {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim().length > 0) {
          yield { kind: "assistant_text", text: block.text };
        } else if (block.type === "tool_use") {
          yield {
            kind: "tool_use",
            toolUseId: block.id,
            toolName: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
          };
        }
      }
      return;
    }
    case "user": {
      const content = message.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (typeof block === "object" && block.type === "tool_result") {
          yield {
            kind: "tool_result",
            toolUseId: block.tool_use_id,
            isError: block.is_error ?? false,
            summary: summarize(block.content),
          };
        }
      }
      return;
    }
    case "result": {
      yield {
        kind: "turn_complete",
        durationMs: message.duration_ms,
        costUsd: message.total_cost_usd,
        isError: message.subtype !== "success",
      };
      yield { kind: "status", status: "idle" };
      return;
    }
    default:
      return;
  }
}

function summarize(content: unknown): string {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((c: { type?: string; text?: string }) =>
        c.type === "text" ? (c.text ?? "") : `[${c.type ?? "block"}]`,
      )
      .join("\n");
  } else {
    text = JSON.stringify(content ?? "");
  }
  return text.length > TOOL_RESULT_SUMMARY_MAX
    ? `${text.slice(0, TOOL_RESULT_SUMMARY_MAX)}…`
    : text;
}
