import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@bosun/protocol";
import { Broker, InMemoryEscalationQueue, StarterPolicy } from "@bosun/broker";
import {
  AsyncQueue,
  type AgentHandle,
  type AgentRunner,
  type AgentStartOptions,
} from "./agent/runner.js";
import { SessionManager } from "./session.js";

/** Records the options each session was started with; never emits work. */
class CapturingRunner implements AgentRunner {
  readonly starts: AgentStartOptions[] = [];
  start(opts: AgentStartOptions): AgentHandle {
    this.starts.push(opts);
    const events = new AsyncQueue<AgentEvent>();
    return {
      events: () => events,
      send: () => undefined,
      interrupt: async () => undefined,
      stop: async () => events.end(),
    };
  }
}

function makeManager(defaults?: { model?: string; skipPermissions?: boolean }) {
  const runner = new CapturingRunner();
  const broker = new Broker(
    new StarterPolicy(),
    new InMemoryEscalationQueue(1000),
  );
  const sessions = new SessionManager(runner, broker, defaults ?? {});
  return { runner, sessions };
}

describe("SessionManager model selection", () => {
  it("passes the requested model to the runner", () => {
    const { runner, sessions } = makeManager();
    sessions.start("/ws", { model: "opus" });
    expect(runner.starts[0]?.model).toBe("opus");
  });

  it("omits model when none is requested or defaulted", () => {
    const { runner, sessions } = makeManager();
    sessions.start("/ws");
    expect(runner.starts[0]?.model).toBeUndefined();
  });

  it("falls back to the default model", () => {
    const { runner, sessions } = makeManager({ model: "sonnet" });
    sessions.start("/ws");
    expect(runner.starts[0]?.model).toBe("sonnet");
  });

  it("per-session model overrides the default", () => {
    const { runner, sessions } = makeManager({ model: "sonnet" });
    sessions.start("/ws", { model: "haiku" });
    expect(runner.starts[0]?.model).toBe("haiku");
  });
});
