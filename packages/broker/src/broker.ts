import type { ToolRequest } from "@bosun/protocol";
import type { PolicyEngine } from "./policy.js";
import type { EscalationQueue } from "./escalation-queue.js";

export type BrokerResult =
  | { behavior: "allow"; reason: string }
  | { behavior: "deny"; reason: string };

export interface PermissionBroker {
  /** Final answer for a tool call. May block on a human via the queue. */
  decide(req: ToolRequest): Promise<BrokerResult>;
}

export class Broker implements PermissionBroker {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly queue: EscalationQueue,
  ) {}

  async decide(req: ToolRequest): Promise<BrokerResult> {
    const decision = this.policy.evaluate(req);
    switch (decision.kind) {
      case "allow":
        return { behavior: "allow", reason: `policy: ${decision.rule}` };
      case "deny":
        return {
          behavior: "deny",
          reason: `${decision.reason} [rule: ${decision.rule}]`,
        };
      case "escalate": {
        const resolution = await this.queue.submit(req, decision.reason);
        switch (resolution) {
          case "approved":
            return { behavior: "allow", reason: "approved from device" };
          case "denied":
            return { behavior: "deny", reason: "denied from device" };
          case "expired":
            return {
              behavior: "deny",
              reason: "escalation expired without a decision (deny by default)",
            };
        }
      }
    }
  }
}
