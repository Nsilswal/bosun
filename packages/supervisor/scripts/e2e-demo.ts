/**
 * End-to-end demo with a REAL Claude Code agent, run entirely on loopback:
 *
 *   supervisor (real SDK session + broker + LAN transport)
 *      ▲
 *      │  paired, encrypted client connection (simulating the phone)
 *      ▼
 *   demo client: sends a 3-part task designed to hit each permission outcome
 *      1. read a file            → policy auto-allow
 *      2. run `ls` (Bash)        → escalates; client approves after 2s
 *      3. run `git push`         → hard-deny
 *
 * Usage: pnpm --filter @bosun/supervisor exec tsx scripts/e2e-demo.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION } from "@bosun/protocol";
import { Broker, InMemoryEscalationQueue, StarterPolicy } from "@bosun/broker";
import { connectLan, generateIdentity, LanTransportServer } from "@bosun/transport";
import { ClaudeAgentRunner } from "../src/agent/claude-runner.js";
import { ProtocolServer } from "../src/server.js";
import { SessionManager } from "../src/session.js";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bosun-demo-"));
fs.writeFileSync(
  path.join(workspace, "hello.txt"),
  "The magic word is: swordfish\n",
);

// ── supervisor side ──────────────────────────────────────────────────────
const queue = new InMemoryEscalationQueue(60_000);
const broker = new Broker(new StarterPolicy(), queue);
const sessions = new SessionManager(new ClaudeAgentRunner(), broker);
const protocol = new ProtocolServer(sessions, queue);
const serverIdentity = generateIdentity();
const allowlist = new Set<string>();
const transport = new LanTransportServer({
  identity: serverIdentity,
  name: "demo",
  isAuthorized: (pk) => allowlist.has(pk),
  onPairRequest: (req) => {
    allowlist.add(req.devicePublicKey);
    return {
      type: "pair.ok",
      supervisorName: "demo",
      supervisorPublicKey: serverIdentity.publicKey,
    };
  },
  advertise: false,
});
transport.onConnection((conn) => protocol.handleConnection(conn));
await transport.start();
const session = sessions.start(workspace);

// ── "phone" side ─────────────────────────────────────────────────────────
const port = transport.buildQrPayload("t", 0).addrs[0]!.port;
const client = await connectLan(
  { host: "127.0.0.1", port },
  generateIdentity(),
  {
    expectedServerPublicKey: serverIdentity.publicKey,
    pairing: { pairingToken: "demo", deviceName: "demo-phone", platform: "ios" },
  },
);

const outcomes: string[] = [];
let done: (() => void) | undefined;
const finished = new Promise<void>((resolve) => (done = resolve));

client.onMessage((env) => {
  const msg = env.msg;
  switch (msg.type) {
    case "agent.event": {
      const e = msg.event.event;
      if (e.kind === "assistant_text") console.log(`\n🤖 ${e.text}`);
      if (e.kind === "tool_use")
        console.log(`🔧 ${e.toolName} ${JSON.stringify(e.input).slice(0, 100)}`);
      if (e.kind === "tool_result")
        console.log(
          `${e.isError ? "🚫" : "✔"} result: ${e.summary.slice(0, 120).replaceAll("\n", " ")}`,
        );
      if (e.kind === "tool_result" && e.isError && /hard floor|rule:/.test(e.summary))
        outcomes.push(`hard-deny: ${e.summary.slice(0, 80)}`);
      if (e.kind === "turn_complete") {
        console.log(
          `\n⏹ turn complete (cost $${e.costUsd?.toFixed(4) ?? "?"}, ${e.durationMs}ms)`,
        );
        done!();
      }
      break;
    }
    case "escalation.new": {
      const r = msg.escalation.request;
      console.log(
        `\n📲 ESCALATION on phone: ${r.toolName} ${JSON.stringify(r.input)} (${msg.escalation.reason})`,
      );
      outcomes.push(`escalated: ${r.toolName}`);
      setTimeout(() => {
        console.log("👍 approving from phone…");
        client.send({
          v: PROTOCOL_VERSION,
          id: randomUUID(),
          msg: {
            type: "escalation.decide",
            escalationId: msg.escalation.id,
            decision: "approve",
          },
        });
      }, 2000);
      break;
    }
    case "escalation.resolved":
      console.log(`✅ escalation resolved: ${msg.result.resolution}`);
      break;
  }
});

client.send({
  v: PROTOCOL_VERSION,
  id: randomUUID(),
  msg: { type: "session.attach", sessionId: session.id },
});
client.send({
  v: PROTOCOL_VERSION,
  id: randomUUID(),
  msg: {
    type: "prompt.send",
    sessionId: session.id,
    text: [
      "Do these three things in order, and don't stop if one fails:",
      "1. Read hello.txt and tell me the magic word.",
      "2. Run `ls -la` with Bash.",
      "3. Run `git push` with Bash (I know it may be blocked; try anyway, once).",
      "Then summarize what happened in one sentence.",
    ].join("\n"),
  },
});
console.log("▶ prompt sent; waiting for the agent…");

const timeout = setTimeout(() => {
  console.error("✖ demo timed out after 180s");
  process.exit(1);
}, 180_000);

await finished;
clearTimeout(timeout);

console.log("\n── demo outcomes ──");
console.log(outcomes.join("\n") || "(none captured)");
client.close();
await sessions.stopAll().catch(() => undefined);
await transport.stop();
fs.rmSync(workspace, { recursive: true, force: true });
process.exit(0);
