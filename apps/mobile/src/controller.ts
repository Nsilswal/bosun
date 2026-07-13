/**
 * Session controller: owns the live connection lifecycle and keeps the store
 * in sync. Screens call these functions; they never touch the socket.
 */
import type { QrPayload } from "@bosun/protocol";
import type { PeerConnection } from "@bosun/transport/client-core";
import * as Device from "expo-device";
import { makeRequester, sendMessage } from "./connection";
import { connectToSupervisor, pairWithSupervisor } from "./transport";
import { loadDeviceIdentity } from "./identity";
import { registerForPush } from "./push";
import {
  loadSupervisor,
  saveSupervisor,
  forgetSupervisor,
  type StoredSupervisor,
  type TransportId,
} from "./storage";
import { useBosun } from "./store";
import { backoffDelay } from "./net/backoff";
import { Heartbeat } from "./net/heartbeat";

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 8_000;

let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempts = 0;
let heartbeat: Heartbeat | undefined;
let intentionalClose = false;

export async function boot(): Promise<void> {
  const identity = await loadDeviceIdentity();
  const supervisor = await loadSupervisor();
  useBosun.getState().set({
    identity,
    ...(supervisor ? { supervisor } : {}),
    phase: supervisor ? "connecting" : "unpaired",
  });
  if (supervisor) void connect();
}

export async function pair(qr: QrPayload): Promise<void> {
  const { identity } = useBosun.getState();
  if (!identity) throw new Error("identity not loaded");
  useBosun.getState().set({ phase: "connecting", connError: undefined });
  try {
    const deviceName = Device.deviceName ?? "phone";
    const { supervisor, conn, transport } = await pairWithSupervisor(
      qr,
      identity,
      deviceName,
    );
    await saveSupervisor(supervisor);
    useBosun.getState().set({ supervisor, activeTransport: transport });
    await adopt(conn);
  } catch (err) {
    useBosun.getState().set({
      phase: "unpaired",
      connError: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function connect(): Promise<void> {
  const { identity, supervisor, phase } = useBosun.getState();
  if (!identity || !supervisor) return;
  if (phase === "connected") return;
  useBosun.getState().set({ phase: "connecting", connError: undefined });
  try {
    const { conn, transport } = await connectToSupervisor(supervisor, identity);
    // Remember the transport that worked so we try it first next time.
    if (supervisor.preferredTransport !== transport) {
      const updated: StoredSupervisor = {
        ...supervisor,
        preferredTransport: transport,
      };
      await saveSupervisor(updated);
      useBosun.getState().set({ supervisor: updated });
    }
    useBosun.getState().set({ activeTransport: transport });
    await adopt(conn);
  } catch (err) {
    useBosun.getState().set({
      phase: "failed",
      connError: err instanceof Error ? err.message : String(err),
    });
    scheduleReconnect();
  }
}

async function adopt(conn: PeerConnection): Promise<void> {
  intentionalClose = false;
  heartbeat?.stop(); // drop any heartbeat from a previous connection
  const store = useBosun.getState();
  const request = makeRequester(conn);

  const onLost = (): void => {
    if (intentionalClose) return;
    heartbeat?.stop();
    useBosun.getState().set({ phase: "reconnecting", conn: undefined });
    scheduleReconnect();
  };

  heartbeat = new Heartbeat({
    intervalMs: HEARTBEAT_INTERVAL_MS,
    timeoutMs: HEARTBEAT_TIMEOUT_MS,
    sendPing: () => sendMessage(conn, { type: "ping" }),
    onDead: onLost,
  });

  conn.onMessage((env) => {
    // Any inbound frame proves liveness; a pong specifically clears the wait.
    heartbeat?.notifyActivity();
    useBosun.getState().applyServerMessage(env.msg as never);
  });
  conn.onClose(onLost);

  store.set({ conn, phase: "connected" });

  const list = await request({ type: "session.list" });
  if (list.type === "session.list.result" && list.sessions.length > 0) {
    const sessionId = list.sessions[0]!.sessionId;
    const sinceSeq = latestSeqIfSameSession(sessionId);
    await request({
      type: "session.attach",
      sessionId,
      ...(sinceSeq !== undefined ? { sinceSeq } : {}),
    }).then((snap) => useBosun.getState().applyServerMessage(snap));
  }

  // Connected and attached: reset backoff and start liveness checks.
  reconnectAttempts = 0;
  heartbeat.start();

  void registerForPush((token) =>
    sendMessage(conn, { type: "push.register", expoPushToken: token }),
  );
}

/** Resume-friendly attach: replay only what we missed after a reconnect. */
function latestSeqIfSameSession(sessionId: string): number | undefined {
  const { activeSessionId, events } = useBosun.getState();
  if (activeSessionId !== sessionId) return undefined;
  return events.at(-1)?.seq;
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = backoffDelay(++reconnectAttempts);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connect();
  }, delay);
}

export function sendPrompt(text: string): void {
  const { conn, activeSessionId } = useBosun.getState();
  if (!conn || !activeSessionId) return;
  sendMessage(conn, { type: "prompt.send", sessionId: activeSessionId, text });
}

export function interruptAgent(): void {
  const { conn, activeSessionId } = useBosun.getState();
  if (!conn || !activeSessionId) return;
  sendMessage(conn, { type: "agent.interrupt", sessionId: activeSessionId });
}

export function decideEscalation(
  escalationId: string,
  decision: "approve" | "deny",
): void {
  const { conn } = useBosun.getState();
  if (!conn) return;
  sendMessage(conn, { type: "escalation.decide", escalationId, decision });
}

/**
 * Spawn a new agent session and make it active (reply is its snapshot).
 * `model` is an alias (e.g. "opus"); omit to use the supervisor's default.
 */
export async function startSession(model?: string): Promise<void> {
  const { conn } = useBosun.getState();
  if (!conn) return;
  const snap = await makeRequester(conn)({
    type: "session.start",
    ...(model !== undefined ? { model } : {}),
  });
  useBosun.getState().applyServerMessage(snap as never);
}

/** Switch the active view to another session, replaying its snapshot. */
export async function switchSession(sessionId: string): Promise<void> {
  const { conn, activeSessionId } = useBosun.getState();
  if (!conn || sessionId === activeSessionId) return;
  const snap = await makeRequester(conn)({ type: "session.attach", sessionId });
  useBosun.getState().applyServerMessage(snap as never);
}

export function stopSession(sessionId: string): void {
  const { conn } = useBosun.getState();
  if (!conn) return;
  sendMessage(conn, { type: "session.stop", sessionId });
}

export async function unpair(): Promise<void> {
  intentionalClose = true;
  heartbeat?.stop();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  reconnectAttempts = 0;
  useBosun.getState().conn?.close();
  await forgetSupervisor();
  useBosun.getState().reset();
  useBosun.getState().set({ supervisor: undefined, phase: "unpaired" });
}
