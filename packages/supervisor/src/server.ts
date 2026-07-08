import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type Envelope,
  type ServerMessage,
} from "@bosun/protocol";
import type { EscalationQueue } from "@bosun/broker";
import type { PeerConnection } from "@bosun/transport";
import type { SessionManager } from "./session.js";

/**
 * Binds authenticated peer connections to sessions and the escalation queue:
 * request/reply handling, live event fan-out to attached devices, and
 * escalation broadcast to every connected device.
 */
export class ProtocolServer {
  private connections = new Set<PeerConnection>();
  /** connection → session ids it is attached to (receives live events). */
  private attachments = new Map<PeerConnection, Set<string>>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly queue: EscalationQueue,
    private readonly hooks: {
      onPushRegister?(devicePublicKey: string, token: string): void;
      onEscalationNew?(): void;
    } = {},
  ) {
    sessions.onEvent((sessionId, event) => {
      this.broadcast(
        { type: "agent.event", sessionId, event },
        (conn) => this.attachments.get(conn)?.has(sessionId) ?? false,
      );
    });

    queue.onChange((change) => {
      if (change.type === "new") {
        this.broadcast({
          type: "escalation.new",
          sessionId: change.escalation.request.sessionId,
          escalation: change.escalation,
        });
        this.hooks.onEscalationNew?.();
      } else {
        this.broadcast({
          type: "escalation.resolved",
          sessionId: change.sessionId,
          result: change.result,
        });
      }
    });
  }

  handleConnection(conn: PeerConnection): void {
    this.connections.add(conn);
    this.attachments.set(conn, new Set());
    conn.onClose(() => {
      this.connections.delete(conn);
      this.attachments.delete(conn);
    });
    conn.onMessage((envelope) => {
      const reply = this.handle(conn, envelope.msg as ClientMessage);
      if (reply) {
        conn.send({
          v: PROTOCOL_VERSION,
          id: randomUUID(),
          re: envelope.id,
          msg: reply,
        });
      }
    });
  }

  private handle(
    conn: PeerConnection,
    msg: ClientMessage,
  ): ServerMessage | undefined {
    switch (msg.type) {
      case "ping":
        return { type: "pong" };

      case "session.list":
        return { type: "session.list.result", sessions: this.sessions.list() };

      case "session.attach": {
        const session = this.sessions.get(msg.sessionId);
        if (!session) return { type: "error", message: "unknown session" };
        this.attachments.get(conn)?.add(msg.sessionId);
        return {
          type: "session.snapshot",
          sessionId: session.id,
          status: session.status,
          cwd: session.cwd,
          events: session.eventsSince(msg.sinceSeq),
          pendingEscalations: this.queue
            .pending()
            .filter((e) => e.request.sessionId === session.id),
        };
      }

      case "prompt.send": {
        const session = this.sessions.get(msg.sessionId);
        if (!session) return { type: "error", message: "unknown session" };
        session.prompt(msg.text);
        return { type: "ok" };
      }

      case "agent.interrupt": {
        const session = this.sessions.get(msg.sessionId);
        if (!session) return { type: "error", message: "unknown session" };
        void session.interrupt();
        return { type: "ok" };
      }

      case "escalation.decide": {
        const resolved = this.queue.resolve(
          msg.escalationId,
          msg.decision,
          conn.peerPublicKey,
        );
        return resolved
          ? { type: "ok" }
          : { type: "error", message: "escalation not pending" };
      }

      case "push.register": {
        this.hooks.onPushRegister?.(conn.peerPublicKey, msg.expoPushToken);
        return { type: "ok" };
      }
    }
  }

  private broadcast(
    msg: ServerMessage,
    filter: (conn: PeerConnection) => boolean = () => true,
  ): void {
    for (const conn of this.connections) {
      if (!filter(conn)) continue;
      conn.send({ v: PROTOCOL_VERSION, id: randomUUID(), msg });
    }
  }
}
