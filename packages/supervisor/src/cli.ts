#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import qrcode from "qrcode-terminal";
import { Broker, InMemoryEscalationQueue, StarterPolicy } from "@bosun/broker";
import { createTransportServer, type RelayConfig } from "@bosun/transport";
import { ClaudeAgentRunner } from "./agent/claude-runner.js";
import { PairingManager } from "./pairing.js";
import { sendEscalationPush } from "./push.js";
import { ProtocolServer } from "./server.js";
import { SessionManager } from "./session.js";
import {
  DeviceAllowlist,
  loadOrCreateIdentity,
  loadOrCreateIrohSecret,
} from "./state.js";

const DEFAULT_PORT = 45450;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const ESCALATION_TIMEOUT_MS = 10 * 60 * 1000;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      port: { type: "string" },
      transport: { type: "string" },
      relay: { type: "string" },
      "no-pair": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`bosun — supervise Claude Code agents from your phone

usage: bosun [workspace-dir] [--name <name>] [--port <port>]
             [--transport lan|p2p] [--relay n0|disabled] [--no-pair]

  workspace-dir   agent workspace (default: current directory)
  --name          supervisor name shown in the app (default: hostname)
  --port          LAN listen port (default: ${DEFAULT_PORT})
  --transport     lan (same network, default) or p2p (off-Wi-Fi, iroh)
  --relay         p2p only: n0 public relays (default) or disabled (direct)
  --no-pair       don't print a pairing QR (already-paired devices only)`);
    return;
  }

  const cwd = path.resolve(positionals[0] ?? process.cwd());
  const name = values.name ?? os.hostname().replace(/\.local$/, "");
  const port = values.port ? Number(values.port) : DEFAULT_PORT;

  const identity = loadOrCreateIdentity();
  const allowlist = new DeviceAllowlist();
  const pairing = new PairingManager();

  const queue = new InMemoryEscalationQueue(ESCALATION_TIMEOUT_MS);
  const broker = new Broker(new StarterPolicy(), queue);
  const sessions = new SessionManager(new ClaudeAgentRunner(), broker);

  const kind = values.transport === "p2p" ? "p2p" : "lan";
  const relay: RelayConfig =
    values.relay === "disabled" ? { mode: "disabled" } : { mode: "n0" };
  const transport = createTransportServer({
    kind,
    identity,
    name,
    port,
    ...(kind === "p2p"
      ? { irohSecretKey: loadOrCreateIrohSecret(), relay }
      : {}),
    isAuthorized: (pk) => allowlist.has(pk),
    onPairRequest: (req) => {
      if (!pairing.redeem(req.pairingToken)) {
        return { type: "pair.error", message: "invalid or expired token" };
      }
      allowlist.add({
        publicKey: req.devicePublicKey,
        name: req.deviceName,
        platform: req.platform,
      });
      console.log(`✔ paired device: ${req.deviceName} (${req.platform})`);
      return {
        type: "pair.ok",
        supervisorName: name,
        supervisorPublicKey: identity.publicKey,
      };
    },
  });

  const protocol = new ProtocolServer(sessions, queue, {
    onPushRegister: (pk, token) => allowlist.setPushToken(pk, token),
    onEscalationNew: () => void sendEscalationPush(allowlist.pushTokens()),
  });
  transport.onConnection((conn) => {
    console.log(`● device connected: ${conn.peerPublicKey.slice(0, 12)}…`);
    protocol.handleConnection(conn);
  });

  queue.onChange((change) => {
    if (change.type === "new") {
      const { toolName, input } = change.escalation.request;
      console.log(
        `⏸ escalation: ${toolName} ${JSON.stringify(input).slice(0, 120)} — waiting for a device…`,
      );
    } else {
      console.log(`▶ escalation ${change.result.resolution}`);
    }
  });

  await transport.start();
  const session = sessions.start(cwd);

  console.log(`\nbosun supervisor "${name}"`);
  console.log(`  workspace: ${cwd}`);
  console.log(`  session:   ${session.id}`);
  console.log(`  transport: ${kind}${kind === "p2p" ? ` (relay: ${relay.mode})` : ""}`);
  for (const a of transport.addresses()) {
    console.log(`  listening: ${a.host}:${a.port}`);
  }

  if (!values["no-pair"]) {
    const { token, expiresAt } = pairing.issue(PAIRING_TTL_MS);
    const qr = JSON.stringify(transport.buildQrPayload(token, expiresAt));
    console.log("\nScan with the Bosun app to pair (valid 10 min):\n");
    qrcode.generate(qr, { small: true }, (code) => console.log(code));
    // Plaintext token + address for the app's manual-pair path (e.g. testing
    // on the iOS Simulator, which has no camera to scan the QR).
    const addr = transport.addresses()[0];
    if (addr) {
      console.log(`Or pair manually — address: ${addr.host}:${addr.port}`);
    }
    console.log(`                   token:   ${token}`);
  }

  const shutdown = async (): Promise<void> => {
    console.log("\nshutting down…");
    await sessions.stopAll().catch(() => undefined);
    await transport.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
