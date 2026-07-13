import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, Envelope, ServerMessage } from "@bosun/protocol";
import { PROTOCOL_VERSION } from "@bosun/protocol";
import {
  Broker,
  InMemoryEscalationQueue,
  StarterPolicy,
  type PermissionBroker,
} from "@bosun/broker";
import {
  connectLan,
  generateIdentity,
  LanTransportServer,
  type PeerConnection,
} from "@bosun/transport";
import {
  AsyncQueue,
  type AgentHandle,
  type AgentRunner,
  type AgentStartOptions,
} from "./agent/runner.js";
import { ProtocolServer } from "./server.js";
import { SessionManager } from "./session.js";

/**
 * Fake agent: on prompt it emits a text event, then drives one Read (policy
 * auto-allow) and one Bash (escalates → blocks on the broker) through the
 * REAL broker, mirroring how the Claude runner calls broker.decide.
 */
class FakeRunner implements AgentRunner {
  start(opts: AgentStartOptions): AgentHandle {
    const events = new AsyncQueue<AgentEvent>();
    const decide = (toolName: string, input: Record<string, unknown>) =>
      opts.broker.decide({
        sessionId: opts.localSessionId,
        toolUseId: `tu-${toolName}`,
        toolName,
        input,
        cwd: opts.cwd,
        requestedAt: Date.now(),
      });

    events.push({ kind: "init", sessionId: "sdk-1", model: "fake", cwd: opts.cwd });
    events.push({ kind: "status", status: "idle" });

    return {
      events: () => events,
      send: (text: string): void => {
        events.push({ kind: "user_prompt", text });
        events.push({ kind: "status", status: "running" });
        void (async () => {
          events.push({ kind: "assistant_text", text: "working on it" });
          const read = await decide("Read", { file_path: "a.ts" });
          events.push({
            kind: "tool_result",
            toolUseId: "tu-Read",
            isError: read.behavior !== "allow",
            summary: read.reason,
          });
          const bash = await decide("Bash", { command: "npm test" });
          events.push({
            kind: "tool_result",
            toolUseId: "tu-Bash",
            isError: bash.behavior !== "allow",
            summary: bash.reason,
          });
          events.push({ kind: "turn_complete", isError: false });
          events.push({ kind: "status", status: "idle" });
        })();
      },
      interrupt: async () => undefined,
      stop: async () => events.end(),
    };
  }
}

interface Harness {
  client: PeerConnection;
  sessionId: string;
  queue: InMemoryEscalationQueue;
  received: Envelope[];
  request(msg: unknown): Promise<ServerMessage>;
  waitFor(pred: (m: ServerMessage) => boolean): Promise<ServerMessage>;
  stop(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const queue = new InMemoryEscalationQueue(30_000);
  const broker: PermissionBroker = new Broker(new StarterPolicy(), queue);
  const sessions = new SessionManager(new FakeRunner(), broker);
  const protocol = new ProtocolServer(sessions, queue, {
    defaultCwd: "/tmp/fake-workspace",
  });

  const serverIdentity = generateIdentity();
  const allowlist = new Set<string>();
  const transport = new LanTransportServer({
    identity: serverIdentity,
    name: "test",
    isAuthorized: (pk) => allowlist.has(pk),
    onPairRequest: (req) => {
      allowlist.add(req.devicePublicKey);
      return {
        type: "pair.ok",
        supervisorName: "test",
        supervisorPublicKey: serverIdentity.publicKey,
      };
    },
    advertise: false,
  });
  transport.onConnection((conn) => protocol.handleConnection(conn));
  await transport.start();

  const session = sessions.start("/tmp/fake-workspace");
  const port = transport.buildQrPayload("t", 0).addrs[0]!.port;
  const client = await connectLan({ host: "127.0.0.1", port }, generateIdentity(), {
    expectedServerPublicKey: serverIdentity.publicKey,
    pairing: { pairingToken: "x", deviceName: "test", platform: "ios" },
  });

  const received: Envelope[] = [];
  const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  client.onMessage((env) => {
    received.push(env);
    const msg = env.msg as ServerMessage;
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(msg)) waiters.splice(i, 1)[0]!.resolve(msg);
    }
  });

  let nextId = 0;
  return {
    client,
    sessionId: session.id,
    queue,
    received,
    request(msg: unknown): Promise<ServerMessage> {
      const id = `req-${nextId++}`;
      const done = new Promise<ServerMessage>((resolve) => {
        const check = (env: Envelope): boolean => env.re === id;
        client.onMessage((env) => {
          if (check(env)) resolve(env.msg as ServerMessage);
        });
      });
      client.send({ v: PROTOCOL_VERSION, id, msg: msg as Envelope["msg"] });
      return done;
    },
    waitFor(pred): Promise<ServerMessage> {
      const hit = received.map((e) => e.msg as ServerMessage).find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => waiters.push({ pred, resolve }));
    },
    stop: () => transport.stop(),
  };
}

const harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.stop()));
});

describe("ProtocolServer end-to-end (fake agent, real broker/transport)", () => {
  it("lists and attaches to the session with replayed events", async () => {
    const h = await harness();
    harnesses.push(h);

    const list = await h.request({ type: "session.list" });
    expect(list.type).toBe("session.list.result");
    if (list.type !== "session.list.result") return;
    expect(list.sessions[0]!.sessionId).toBe(h.sessionId);

    const snap = await h.request({
      type: "session.attach",
      sessionId: h.sessionId,
    });
    expect(snap.type).toBe("session.snapshot");
    if (snap.type !== "session.snapshot") return;
    expect(snap.events.map((e) => e.event.kind)).toContain("init");
  });

  it("runs the full escalation round-trip: prompt → escalation.new → decide → unblock", async () => {
    const h = await harness();
    harnesses.push(h);

    await h.request({ type: "session.attach", sessionId: h.sessionId });
    await h.request({
      type: "prompt.send",
      sessionId: h.sessionId,
      text: "do the thing",
    });

    // Auto-approved Read lands without any escalation.
    const readResult = await h.waitFor(
      (m) =>
        m.type === "agent.event" &&
        m.event.event.kind === "tool_result" &&
        m.event.event.toolUseId === "tu-Read",
    );
    if (
      readResult.type === "agent.event" &&
      readResult.event.event.kind === "tool_result"
    ) {
      expect(readResult.event.event.isError).toBe(false);
      expect(readResult.event.event.summary).toContain("policy");
    }

    // Bash escalates: broadcast arrives, agent is blocked.
    const escalation = await h.waitFor((m) => m.type === "escalation.new");
    if (escalation.type !== "escalation.new") return;
    expect(escalation.escalation.request.toolName).toBe("Bash");
    expect(h.queue.pending()).toHaveLength(1);

    // Approve from the "phone".
    const ok = await h.request({
      type: "escalation.decide",
      escalationId: escalation.escalation.id,
      decision: "approve",
    });
    expect(ok.type).toBe("ok");

    const resolved = await h.waitFor((m) => m.type === "escalation.resolved");
    if (resolved.type === "escalation.resolved") {
      expect(resolved.result.resolution).toBe("approved");
    }

    // The blocked tool call completed with the approval.
    const bashResult = await h.waitFor(
      (m) =>
        m.type === "agent.event" &&
        m.event.event.kind === "tool_result" &&
        m.event.event.toolUseId === "tu-Bash",
    );
    if (
      bashResult.type === "agent.event" &&
      bashResult.event.event.kind === "tool_result"
    ) {
      expect(bashResult.event.event.isError).toBe(false);
      expect(bashResult.event.event.summary).toContain("approved from device");
    }

    // Replay: a second attach with sinceSeq returns only newer events.
    const snap = await h.request({
      type: "session.attach",
      sessionId: h.sessionId,
      sinceSeq: 2,
    });
    if (snap.type === "session.snapshot") {
      expect(snap.events.every((e) => e.seq > 2)).toBe(true);
    }
  });

  it("rejects decisions on unknown escalations", async () => {
    const h = await harness();
    harnesses.push(h);
    const res = await h.request({
      type: "escalation.decide",
      escalationId: "nope",
      decision: "approve",
    });
    expect(res.type).toBe("error");
  });

  it("answers ping and unknown-session errors", async () => {
    const h = await harness();
    harnesses.push(h);
    expect((await h.request({ type: "ping" })).type).toBe("pong");
    const err = await h.request({
      type: "prompt.send",
      sessionId: "missing",
      text: "x",
    });
    expect(err.type).toBe("error");
  });

  it("starts, lists, and stops multiple concurrent sessions", async () => {
    const h = await harness();
    harnesses.push(h);

    // One session exists from harness setup.
    const before = await h.request({ type: "session.list" });
    const initialCount =
      before.type === "session.list.result" ? before.sessions.length : 0;
    expect(initialCount).toBe(1);

    // Start two more; each reply is that session's snapshot.
    const startA = await h.request({ type: "session.start" });
    expect(startA.type).toBe("session.snapshot");
    const startB = await h.request({ type: "session.start" });
    expect(startB.type).toBe("session.snapshot");
    const idA =
      startA.type === "session.snapshot" ? startA.sessionId : "";
    const idB =
      startB.type === "session.snapshot" ? startB.sessionId : "";
    expect(idA).not.toBe(idB);

    const after = await h.request({ type: "session.list" });
    expect(after.type === "session.list.result" && after.sessions.length).toBe(
      3,
    );

    // Prompts route to the right session independently.
    await h.request({ type: "prompt.send", sessionId: idA, text: "hi A" });
    const evA = await h.waitFor(
      (m) =>
        m.type === "agent.event" &&
        m.sessionId === idA &&
        m.event.event.kind === "user_prompt",
    );
    expect(evA.type).toBe("agent.event");

    // Stop one; the list shrinks and a broadcast reflects it.
    const stopped = await h.request({ type: "session.stop", sessionId: idA });
    expect(stopped.type).toBe("ok");
    await h.waitFor(
      (m) => m.type === "session.list.result" && m.sessions.length === 2,
    );

    // Stopping an unknown session errors.
    const bad = await h.request({ type: "session.stop", sessionId: "nope" });
    expect(bad.type).toBe("error");
  });
});
