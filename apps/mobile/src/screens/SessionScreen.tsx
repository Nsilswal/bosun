import { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { PendingEscalation, SequencedEvent } from "@bosun/protocol";
import { decideEscalation, interruptAgent, sendPrompt, unpair } from "../controller";
import { useBosun } from "../store";
import { colors, statusColor } from "../theme";

export function SessionScreen() {
  const supervisor = useBosun((s) => s.supervisor);
  const phase = useBosun((s) => s.phase);
  const status = useBosun((s) => s.sessionStatus);
  const events = useBosun((s) => s.events);
  const pending = useBosun((s) => s.pending);
  const [draft, setDraft] = useState("");
  const list = useRef<FlatList<SequencedEvent>>(null);

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
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{supervisor?.name ?? "agent"}</Text>
          <View style={styles.statusRow}>
            <View
              style={[
                styles.dot,
                { backgroundColor: online ? statusColor[status] : colors.danger },
              ]}
            />
            <Text style={styles.statusText}>
              {online ? status.replace("_", " ") : phase}
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

      <FlatList
        ref={list}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={events}
        keyExtractor={(item) => String(item.seq)}
        renderItem={({ item }) => <EventRow item={item} />}
      />

      {pending.map((esc) => (
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
