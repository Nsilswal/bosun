import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  SequencedEvent,
  SessionStatus,
  SessionSummary,
} from "@bosun/protocol";
import type { PermissionBroker } from "@bosun/broker";
import type { AgentHandle, AgentRunner } from "./agent/runner.js";

const EVENT_LOG_CAP = 1000;

export type SessionListener = (sessionId: string, event: SequencedEvent) => void;

export class Session {
  status: SessionStatus = "starting";
  lastActivityAt: number = Date.now();
  /** Ring buffer of sequenced events for attach/replay. */
  private log: SequencedEvent[] = [];
  private nextSeq = 0;

  constructor(
    readonly id: string,
    readonly cwd: string,
    private readonly handle: AgentHandle,
    private readonly emit: SessionListener,
  ) {
    void this.pump();
  }

  private async pump(): Promise<void> {
    for await (const event of this.handle.events()) {
      this.record(event);
    }
  }

  record(event: AgentEvent): void {
    if (event.kind === "status") this.status = event.status;
    this.lastActivityAt = Date.now();
    const sequenced: SequencedEvent = {
      seq: this.nextSeq++,
      at: this.lastActivityAt,
      event,
    };
    this.log.push(sequenced);
    if (this.log.length > EVENT_LOG_CAP) this.log.shift();
    this.emit(this.id, sequenced);
  }

  eventsSince(sinceSeq?: number): SequencedEvent[] {
    if (sinceSeq === undefined) return [...this.log];
    return this.log.filter((e) => e.seq > sinceSeq);
  }

  prompt(text: string): void {
    this.handle.send(text);
  }

  interrupt(): Promise<void> {
    return this.handle.interrupt();
  }

  stop(): Promise<void> {
    return this.handle.stop();
  }

  summary(): SessionSummary {
    return {
      sessionId: this.id,
      cwd: this.cwd,
      status: this.status,
      lastActivityAt: this.lastActivityAt,
    };
  }
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private listeners = new Set<SessionListener>();
  private changeListeners = new Set<() => void>();

  constructor(
    private readonly runner: AgentRunner,
    private readonly broker: PermissionBroker,
    private readonly defaults: { skipPermissions?: boolean } = {},
  ) {}

  start(cwd: string, opts: { skipPermissions?: boolean } = {}): Session {
    // The id must exist before the runner starts: the broker's tool requests
    // reference it, and escalations must agree with the event stream.
    const localSessionId = randomUUID();
    const skipPermissions = opts.skipPermissions ?? this.defaults.skipPermissions;
    const handle = this.runner.start({
      localSessionId,
      cwd,
      broker: this.broker,
      ...(skipPermissions !== undefined ? { skipPermissions } : {}),
    });
    const session = new Session(localSessionId, cwd, handle, (id, ev) => {
      for (const cb of this.listeners) cb(id, ev);
    });
    this.sessions.set(localSessionId, session);
    this.notifyChange();
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => s.summary());
  }

  /** Stop and forget a session. Returns false if the id is unknown. */
  async stop(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    await session.stop().catch(() => undefined);
    this.notifyChange();
    return true;
  }

  onEvent(cb: SessionListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Notified whenever the set of sessions changes (start/stop). */
  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  private notifyChange(): void {
    for (const cb of this.changeListeners) cb();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.stop()));
  }
}
