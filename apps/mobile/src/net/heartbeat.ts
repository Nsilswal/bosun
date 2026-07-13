export interface HeartbeatOptions {
  /** How often to send a ping while the connection is quiet. */
  intervalMs: number;
  /** How long to wait for a pong before declaring the connection dead. */
  timeoutMs: number;
  sendPing: () => void;
  onDead: () => void;
}

/**
 * Liveness check for a connection. Mobile sockets frequently die silently on
 * network switches without ever firing `onClose`; a ping with no pong within
 * `timeoutMs` catches that half-open state so we can reconnect proactively.
 *
 * Any inbound traffic counts as liveness — call `notifyActivity()` on every
 * message and `notifyPong()` when a pong arrives.
 */
export class Heartbeat {
  private tickTimer?: ReturnType<typeof setTimeout>;
  private waitTimer?: ReturnType<typeof setTimeout>;
  private stopped = true;

  constructor(private readonly opts: HeartbeatOptions) {}

  start(): void {
    this.stopped = false;
    this.scheduleTick();
  }

  stop(): void {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.tickTimer = undefined;
    this.waitTimer = undefined;
  }

  /** A pong (or any inbound message) proves the connection is alive. */
  notifyActivity(): void {
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = undefined;
    }
  }

  private scheduleTick(): void {
    this.tickTimer = setTimeout(() => {
      if (this.stopped) return;
      // Arm the death timer BEFORE sending, so even a pong that comes back
      // on the very next tick clears a timer that's already running.
      this.waitTimer = setTimeout(() => {
        if (this.stopped) return;
        this.stop();
        this.opts.onDead();
      }, this.opts.timeoutMs);
      this.opts.sendPing();
      this.scheduleTick();
    }, this.opts.intervalMs);
  }
}
