import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type {
  PendingEscalation,
  SequencedEvent,
  SessionSummary,
} from "@bosun/protocol";
import { DEFAULT_MODEL_ID, MODEL_OPTIONS, resolveModel } from "@bosun/protocol";
import {
  decideEscalation,
  interruptAgent,
  sendPrompt,
  startSession,
  stopSession,
  switchSession,
  unpair,
} from "../controller";
import { useBosun } from "../store";
import { colors, statusColor } from "../theme";

function workspaceLabel(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

type SessionUiState =
  | { kind: "waiting"; label: string; color: string }
  | { kind: "working"; label: string; color: string }
  | { kind: "idle"; label: string; color: string }
  | { kind: "other"; label: string; color: string };

function sessionUiState(
  status: SessionSummary["status"],
  pendingCount: number,
): SessionUiState {
  if (pendingCount > 0) {
    return { kind: "waiting", label: "Waiting for you", color: colors.warn };
  }
  switch (status) {
    case "running":
      return { kind: "working", label: "Working…", color: colors.accent };
    case "idle":
      return { kind: "idle", label: "Idle", color: colors.ok };
    case "starting":
      return { kind: "other", label: "Starting…", color: colors.textDim };
    case "error":
      return { kind: "other", label: "Error", color: colors.danger };
    case "exited":
      return { kind: "other", label: "Exited", color: colors.textDim };
    default:
      return { kind: "other", label: status, color: colors.textDim };
  }
}

/** Small leading indicator: spinner while working, coloured dot otherwise. */
function StateIndicator({ state }: { state: SessionUiState }) {
  if (state.kind === "working") {
    return <ActivityIndicator size="small" color={state.color} />;
  }
  return <View style={[styles.stateDot, { backgroundColor: state.color }]} />;
}

function Sidebar({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const sessions = useBosun((s) => s.sessions);
  const activeSessionId = useBosun((s) => s.activeSessionId);
  const pending = useBosun((s) => s.pending);
  const supervisor = useBosun((s) => s.supervisor);
  const [modelId, setModelId] = useState<string>(DEFAULT_MODEL_ID);

  const pendingFor = (id: string) =>
    pending.filter((p) => p.request.sessionId === id).length;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sidebar} onPress={() => {}}>
          <Text style={styles.sidebarSup}>{supervisor?.name ?? "supervisor"}</Text>
          <Text style={styles.sidebarTitle}>Sessions</Text>

          <ScrollView style={styles.sidebarList}>
            {sessions.map((s) => {
              const count = pendingFor(s.sessionId);
              const state = sessionUiState(s.status, count);
              const active = s.sessionId === activeSessionId;
              return (
                <Pressable
                  key={s.sessionId}
                  style={[styles.sessionRow, active && styles.sessionRowActive]}
                  onPress={() => {
                    void switchSession(s.sessionId);
                    onClose();
                  }}
                  onLongPress={() => stopSession(s.sessionId)}
                >
                  <View style={styles.sessionRowTop}>
                    <Text style={styles.sessionName} numberOfLines={1}>
                      {workspaceLabel(s.cwd)}
                    </Text>
                    {active && <Text style={styles.activeTick}>✓</Text>}
                  </View>
                  <View style={styles.sessionStateRow}>
                    <StateIndicator state={state} />
                    <Text style={[styles.stateText, { color: state.color }]}>
                      {state.label}
                      {count > 0 ? ` · ${count}` : ""}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>

          <Text style={styles.modelLabel}>Model</Text>
          <View style={styles.modelRow}>
            {MODEL_OPTIONS.map((m) => {
              const selected = m.id === modelId;
              return (
                <Pressable
                  key={m.id}
                  style={[styles.modelChip, selected && styles.modelChipActive]}
                  onPress={() => setModelId(m.id)}
                >
                  <Text
                    style={[
                      styles.modelChipText,
                      selected && styles.modelChipTextActive,
                    ]}
                  >
                    {m.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Pressable
            style={styles.newSessionBtn}
            onPress={() => {
              void startSession(resolveModel(modelId));
              onClose();
            }}
          >
            <Text style={styles.newSessionText}>＋  New session</Text>
          </Pressable>
          <Text style={styles.sidebarHint}>Long-press a session to stop it</Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function SessionScreen() {
  const supervisor = useBosun((s) => s.supervisor);
  const phase = useBosun((s) => s.phase);
  const activeTransport = useBosun((s) => s.activeTransport);
  const status = useBosun((s) => s.sessionStatus);
  const events = useBosun((s) => s.events);
  const pending = useBosun((s) => s.pending);
  const sessions = useBosun((s) => s.sessions);
  const activeSessionId = useBosun((s) => s.activeSessionId);
  const [draft, setDraft] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const list = useRef<FlatList<SequencedEvent>>(null);

  const activeCwd = sessions.find(
    (s) => s.sessionId === activeSessionId,
  )?.cwd;
  const headerTitle = activeCwd
    ? workspaceLabel(activeCwd)
    : (supervisor?.name ?? "agent");

  // Cards belong to the session currently in view.
  const activePending = pending.filter(
    (p) => p.request.sessionId === activeSessionId,
  );
  // A background session needs attention → dot on the menu button.
  const backgroundNeedsYou = pending.some(
    (p) => p.request.sessionId !== activeSessionId,
  );

  useEffect(() => {
    const t = setTimeout(() => list.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(t);
  }, [events.length]);

  const onSend = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    sendPrompt(text);
    setDraft("");
  }, [draft]);

  const online = phase === "connected";

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Pressable
          style={styles.menuBtn}
          onPress={() => setSidebarOpen(true)}
          hitSlop={8}
        >
          <Text style={styles.menuIcon}>☰</Text>
          {backgroundNeedsYou && <View style={styles.menuBadge} />}
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {headerTitle}
          </Text>
          <View style={styles.statusRow}>
            <View
              style={[
                styles.dot,
                { backgroundColor: online ? statusColor[status] : colors.danger },
              ]}
            />
            <Text style={styles.statusText}>
              {online ? status.replace("_", " ") : phase}
              {online && activeTransport
                ? ` · ${activeTransport.toUpperCase()}`
                : ""}
            </Text>
          </View>
        </View>
        {status === "running" && (
          <Pressable style={styles.stopBtn} onPress={interruptAgent}>
            <Text style={styles.stopBtnText}>stop</Text>
          </Pressable>
        )}
        <Pressable onPress={() => void unpair()} hitSlop={8}>
          <Text style={styles.unpair}>unpair</Text>
        </Pressable>
      </View>

      <Sidebar visible={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <FlatList
        ref={list}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={events}
        keyExtractor={(item) => String(item.seq)}
        renderItem={({ item }) => <EventRow item={item} />}
      />

      {activePending.map((esc) => (
        <EscalationCard key={esc.id} escalation={esc} />
      ))}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          placeholder={online ? "Message the agent…" : "reconnecting…"}
          placeholderTextColor={colors.textDim}
          value={draft}
          onChangeText={setDraft}
          editable={online}
          multiline
        />
        <Pressable
          style={[styles.sendBtn, (!online || !draft.trim()) && { opacity: 0.4 }]}
          disabled={!online || !draft.trim()}
          onPress={onSend}
        >
          <Text style={styles.sendBtnText}>↑</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function EventRow({ item }: { item: SequencedEvent }) {
  const e = item.event;
  switch (e.kind) {
    case "user_prompt":
      return (
        <View style={[styles.bubble, styles.userBubble]}>
          <Text style={styles.userText}>{e.text}</Text>
        </View>
      );
    case "assistant_text":
      return (
        <View style={[styles.bubble, styles.agentBubble]}>
          <Text style={styles.agentText}>{e.text}</Text>
        </View>
      );
    case "tool_use":
      return (
        <View style={styles.toolRow}>
          <Text style={styles.toolText} numberOfLines={2}>
            🔧 {e.toolName} {previewInput(e.input)}
          </Text>
        </View>
      );
    case "tool_result":
      return (
        <View style={styles.toolRow}>
          <Text
            style={[styles.toolText, e.isError && { color: colors.danger }]}
            numberOfLines={3}
          >
            {e.isError ? "🚫" : "✓"} {e.summary.trim() || "(no output)"}
          </Text>
        </View>
      );
    case "turn_complete":
      return (
        <Text style={styles.meta}>
          — turn complete{e.costUsd != null ? ` · $${e.costUsd.toFixed(4)}` : ""} —
        </Text>
      );
    case "init":
      return (
        <Text style={styles.meta}>
          session started · {e.model} · {e.cwd}
        </Text>
      );
    default:
      return null;
  }
}

function EscalationCard({ escalation }: { escalation: PendingEscalation }) {
  const { toolName, input } = escalation.request;
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Agent wants to run</Text>
      <Text style={styles.cardTool}>
        {toolName} {previewInput(input)}
      </Text>
      <Text style={styles.cardReason}>{escalation.reason}</Text>
      <View style={styles.cardButtons}>
        <Pressable
          style={[styles.cardBtn, styles.denyBtn]}
          onPress={() => decideEscalation(escalation.id, "deny")}
        >
          <Text style={styles.denyText}>Deny</Text>
        </Pressable>
        <Pressable
          style={[styles.cardBtn, styles.approveBtn]}
          onPress={() => decideEscalation(escalation.id, "approve")}
        >
          <Text style={styles.approveText}>Approve</Text>
        </Pressable>
      </View>
    </View>
  );
}

function previewInput(input: Record<string, unknown>): string {
  const value =
    (typeof input.command === "string" && input.command) ||
    (typeof input.file_path === "string" && input.file_path) ||
    JSON.stringify(input);
  return String(value).slice(0, 120);
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 60,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 12,
  },
  menuBtn: { width: 28, alignItems: "flex-start", justifyContent: "center" },
  menuIcon: { color: colors.text, fontSize: 22 },
  menuBadge: {
    position: "absolute",
    top: 0,
    right: 0,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.warn,
    borderWidth: 1,
    borderColor: colors.bg,
  },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: colors.textDim, fontSize: 13 },
  stopBtn: {
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  stopBtnText: { color: colors.danger, fontSize: 13 },
  unpair: { color: colors.textDim, fontSize: 13 },

  // Sidebar drawer
  backdrop: { flex: 1, flexDirection: "row", backgroundColor: "#000A" },
  sidebar: {
    width: 300,
    maxWidth: "82%",
    flex: 1,
    backgroundColor: colors.surface,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    paddingTop: 64,
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  sidebarSup: { color: colors.textDim, fontSize: 13 },
  sidebarTitle: {
    color: colors.text,
    fontSize: 22,
    fontWeight: "700",
    marginTop: 2,
    marginBottom: 12,
  },
  sidebarList: { flex: 1 },
  sessionRow: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    marginBottom: 8,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 6,
  },
  sessionRowActive: { borderColor: colors.accent, backgroundColor: colors.surfaceRaised },
  sessionRowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sessionName: { color: colors.text, fontSize: 15, fontWeight: "600", flex: 1 },
  activeTick: { color: colors.accent, fontSize: 15, fontWeight: "700" },
  sessionStateRow: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 16 },
  stateDot: { width: 8, height: 8, borderRadius: 4 },
  stateText: { fontSize: 13 },
  modelLabel: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 12,
    marginBottom: 6,
  },
  modelRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  modelChip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  modelChipActive: { borderColor: colors.accent, backgroundColor: colors.surfaceRaised },
  modelChipText: { color: colors.textDim, fontSize: 13, fontWeight: "600" },
  modelChipTextActive: { color: colors.accent },
  newSessionBtn: {
    marginTop: 8,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: colors.accent,
  },
  newSessionText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  sidebarHint: { color: colors.textDim, fontSize: 12, textAlign: "center", marginTop: 10 },

  list: { flex: 1 },
  listContent: { padding: 12, gap: 8 },
  bubble: { maxWidth: "85%", borderRadius: 14, padding: 12 },
  userBubble: { alignSelf: "flex-end", backgroundColor: colors.accent },
  userText: { color: "#fff", fontSize: 15, lineHeight: 21 },
  agentBubble: { alignSelf: "flex-start", backgroundColor: colors.surfaceRaised },
  agentText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  toolRow: {
    backgroundColor: colors.surface,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  toolText: { color: colors.textDim, fontSize: 12, fontFamily: "Menlo" },
  meta: { color: colors.textDim, fontSize: 12, textAlign: "center", marginVertical: 4 },
  card: {
    margin: 12,
    marginBottom: 0,
    padding: 14,
    borderRadius: 14,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.warn,
    gap: 6,
  },
  cardTitle: { color: colors.warn, fontSize: 12, fontWeight: "700", textTransform: "uppercase" },
  cardTool: { color: colors.text, fontSize: 14, fontFamily: "Menlo" },
  cardReason: { color: colors.textDim, fontSize: 13 },
  cardButtons: { flexDirection: "row", gap: 10, marginTop: 8 },
  cardBtn: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  denyBtn: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.danger },
  denyText: { color: colors.danger, fontWeight: "600" },
  approveBtn: { backgroundColor: colors.ok },
  approveText: { color: "#04260D", fontWeight: "700" },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 12,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  input: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    color: colors.text,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    maxHeight: 120,
  },
  sendBtn: {
    backgroundColor: colors.accent,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnText: { color: "#fff", fontSize: 20, fontWeight: "700" },
});
