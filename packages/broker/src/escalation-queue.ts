import { randomUUID } from "node:crypto";
import type {
  EscalationDecision,
  EscalationResolution,
  PendingEscalation,
  ResolvedEscalation,
  ToolRequest,
} from "@bosun/protocol";

export type EscalationEvent =
  | { type: "new"; escalation: PendingEscalation }
  | { type: "resolved"; result: ResolvedEscalation; sessionId: string };

export type Unsubscribe = () => void;

export interface EscalationQueue {
  /**
   * Enqueue a request the policy couldn't clear. The returned promise is the
   * blocking point: it settles when a device decides or the escalation
   * expires (expiry = denied).
   */
  submit(req: ToolRequest, reason: string): Promise<EscalationResolution>;
  pending(): PendingEscalation[];
  /** Returns false if the escalation is unknown or already resolved. */
  resolve(
    id: string,
    decision: EscalationDecision,
    resolvedBy: string,
  ): boolean;
  onChange(cb: (event: EscalationEvent) => void): Unsubscribe;
}

interface QueueEntry {
  escalation: PendingEscalation;
  settle: (resolution: EscalationResolution) => void;
  timer: NodeJS.Timeout;
}

export class InMemoryEscalationQueue implements EscalationQueue {
  private entries = new Map<string, QueueEntry>();
  private listeners = new Set<(event: EscalationEvent) => void>();

  constructor(private readonly timeoutMs: number = 10 * 60 * 1000) {}

  submit(req: ToolRequest, reason: string): Promise<EscalationResolution> {
    const now = Date.now();
    const escalation: PendingEscalation = {
      id: randomUUID(),
      request: req,
      reason,
      createdAt: now,
      expiresAt: now + this.timeoutMs,
    };

    return new Promise<EscalationResolution>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.settle(escalation.id, "expired", undefined);
      }, this.timeoutMs);
      timer.unref?.();

      this.entries.set(escalation.id, {
        escalation,
        settle: resolvePromise,
        timer,
      });
      this.emit({ type: "new", escalation });
    });
  }

  pending(): PendingEscalation[] {
    return [...this.entries.values()].map((e) => e.escalation);
  }

  resolve(
    id: string,
    decision: EscalationDecision,
    resolvedBy: string,
  ): boolean {
    return this.settle(
      id,
      decision === "approve" ? "approved" : "denied",
      resolvedBy,
    );
  }

  onChange(cb: (event: EscalationEvent) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private settle(
    id: string,
    resolution: EscalationResolution,
    resolvedBy: string | undefined,
  ): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    entry.settle(resolution);
    this.emit({
      type: "resolved",
      sessionId: entry.escalation.request.sessionId,
      result: {
        id,
        resolution,
        ...(resolvedBy !== undefined ? { resolvedBy } : {}),
        resolvedAt: Date.now(),
      },
    });
    return true;
  }

  private emit(event: EscalationEvent): void {
    for (const cb of this.listeners) cb(event);
  }
}
