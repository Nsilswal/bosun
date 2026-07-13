import { create } from "zustand";
import type {
  PendingEscalation,
  ResolvedEscalation,
  SequencedEvent,
  ServerMessage,
  SessionStatus,
  SessionSummary,
} from "@bosun/protocol";
import type {
  PeerConnection,
  StoredIdentity,
} from "@bosun/transport/client-core";
import type { StoredSupervisor, TransportId } from "./storage";

export type ConnectionPhase =
  | "boot"
  | "unpaired"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

interface BosunState {
  identity?: StoredIdentity;
  supervisor?: StoredSupervisor;
  phase: ConnectionPhase;
  conn?: PeerConnection;
  connError?: string;
  /** Transport carrying the live connection ("lan" | "p2p"). */
  activeTransport?: TransportId;

  sessions: SessionSummary[];
  activeSessionId?: string;
  sessionStatus: SessionStatus;
  events: SequencedEvent[];
  pending: PendingEscalation[];
  lastResolved?: ResolvedEscalation;

  set: (partial: Partial<BosunState>) => void;
  applyServerMessage: (msg: ServerMessage) => void;
  reset: () => void;
}

export const useBosun = create<BosunState>((set, get) => ({
  phase: "boot",
  sessions: [],
  sessionStatus: "starting",
  events: [],
  pending: [],

  set: (partial) => set(partial),

  applyServerMessage: (msg) => {
    const state = get();
    switch (msg.type) {
      case "session.list.result": {
        const next: Partial<BosunState> = { sessions: msg.sessions };
        // If the active session was stopped elsewhere, drop the stale view.
        if (
          state.activeSessionId &&
          !msg.sessions.some((s) => s.sessionId === state.activeSessionId)
        ) {
          next.activeSessionId = undefined;
          next.events = [];
          next.sessionStatus = "exited";
        }
        set(next);
        return;
      }

      case "session.snapshot": {
        set({
          activeSessionId: msg.sessionId,
          sessionStatus: msg.status,
          events: msg.events,
          // Replace only this session's pending; keep other sessions' cards.
          pending: [
            ...state.pending.filter(
              (p) => p.request.sessionId !== msg.sessionId,
            ),
            ...msg.pendingEscalations,
          ],
        });
        return;
      }

      case "agent.event": {
        if (msg.sessionId !== state.activeSessionId) return;
        const event = msg.event;
        // Drop replays/dupes; the log is strictly seq-ordered.
        const lastSeq = state.events.at(-1)?.seq ?? -1;
        if (event.seq <= lastSeq) return;
        const next: Partial<BosunState> = {
          events: [...state.events, event].slice(-500),
        };
        if (event.event.kind === "status") {
          next.sessionStatus = event.event.status;
        }
        set(next);
        return;
      }

      case "escalation.new": {
        if (state.pending.some((p) => p.id === msg.escalation.id)) return;
        set({ pending: [...state.pending, msg.escalation] });
        return;
      }

      case "escalation.resolved": {
        set({
          pending: state.pending.filter((p) => p.id !== msg.result.id),
          lastResolved: msg.result,
        });
        return;
      }

      default:
        return;
    }
  },

  reset: () =>
    set({
      conn: undefined,
      activeTransport: undefined,
      sessions: [],
      activeSessionId: undefined,
      sessionStatus: "starting",
      events: [],
      pending: [],
    }),
}));
