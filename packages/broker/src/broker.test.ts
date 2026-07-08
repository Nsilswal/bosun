import { describe, expect, it } from "vitest";
import type { ToolRequest } from "@bosun/protocol";
import { Broker } from "./broker.js";
import { InMemoryEscalationQueue } from "./escalation-queue.js";
import { StarterPolicy } from "./policy.js";

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

function setup(timeoutMs = 10_000) {
  const queue = new InMemoryEscalationQueue(timeoutMs);
  const broker = new Broker(new StarterPolicy(), queue);
  return { queue, broker };
}

describe("InMemoryEscalationQueue", () => {
  it("blocks until resolved, then reports the resolver", async () => {
    const queue = new InMemoryEscalationQueue(10_000);
    const events: string[] = [];
    queue.onChange((e) => events.push(e.type));

    const pendingResolution = queue.submit(req("Bash", { command: "ls" }), "why");
    expect(queue.pending()).toHaveLength(1);

    const id = queue.pending()[0]!.id;
    expect(queue.resolve(id, "approve", "device-pk")).toBe(true);
    await expect(pendingResolution).resolves.toBe("approved");
    expect(queue.pending()).toHaveLength(0);
    expect(events).toEqual(["new", "resolved"]);
  });

  it("rejects double-resolution", async () => {
    const queue = new InMemoryEscalationQueue(10_000);
    const p = queue.submit(req("Bash", { command: "ls" }), "why");
    const id = queue.pending()[0]!.id;
    expect(queue.resolve(id, "deny", "pk")).toBe(true);
    expect(queue.resolve(id, "approve", "pk")).toBe(false);
    await expect(p).resolves.toBe("denied");
  });

  it("expires to denied after the timeout", async () => {
    const queue = new InMemoryEscalationQueue(20);
    const p = queue.submit(req("Bash", { command: "ls" }), "why");
    await expect(p).resolves.toBe("expired");
    expect(queue.pending()).toHaveLength(0);
  });
});

describe("Broker", () => {
  it("auto-allows what policy allows, without touching the queue", async () => {
    const { broker, queue } = setup();
    const result = await broker.decide(req("Read", { file_path: "x" }));
    expect(result.behavior).toBe("allow");
    expect(queue.pending()).toHaveLength(0);
  });

  it("auto-denies hard-floor violations without touching the queue", async () => {
    const { broker, queue } = setup();
    const result = await broker.decide(req("Bash", { command: "git push" }));
    expect(result.behavior).toBe("deny");
    expect(queue.pending()).toHaveLength(0);
  });

  it("escalates Bash and honors an approval", async () => {
    const { broker, queue } = setup();
    const decision = broker.decide(req("Bash", { command: "npm test" }));
    const id = queue.pending()[0]!.id;
    queue.resolve(id, "approve", "pk");
    await expect(decision).resolves.toEqual({
      behavior: "allow",
      reason: "approved from device",
    });
  });

  it("escalates and honors a denial", async () => {
    const { broker, queue } = setup();
    const decision = broker.decide(req("Bash", { command: "npm test" }));
    queue.resolve(queue.pending()[0]!.id, "deny", "pk");
    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
  });

  it("denies when the escalation expires", async () => {
    const { broker } = setup(20);
    const result = await broker.decide(req("Bash", { command: "npm test" }));
    expect(result.behavior).toBe("deny");
    expect(result.reason).toContain("expired");
  });
});
