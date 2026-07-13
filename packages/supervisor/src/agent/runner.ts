import type { AgentEvent } from "@bosun/protocol";
import type { PermissionBroker } from "@bosun/broker";

/**
 * Provider-facing seam. Claude Code is the only implementation today; other
 * agent backends slot in here later.
 */
export interface AgentRunner {
  start(opts: AgentStartOptions): AgentHandle;
}

export interface AgentStartOptions {
  /** Supervisor-local session id; used in all protocol traffic. */
  localSessionId: string;
  cwd: string;
  broker: PermissionBroker;
  /** Resume a provider session (SDK `resume`). Handoff slice — unused today. */
  resumeProviderSessionId?: string;
  /**
   * Run the agent in bypassPermissions mode (Claude Code's
   * --dangerously-skip-permissions). The SDK then never calls canUseTool, so
   * the broker's escalation-to-phone path is OFF and the agent runs
   * unattended. The deterministic hard-floor hook is still installed to
   * attempt the never-cross rules. Only sensible on a trusted machine.
   */
  skipPermissions?: boolean;
}

export interface AgentHandle {
  events(): AsyncIterable<AgentEvent>;
  send(text: string): void;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
}

/** Pushable async iterable — bridges event callbacks into for-await loops. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.buffer.push(item);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.buffer.shift();
        if (item !== undefined) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
