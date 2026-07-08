import { useEffect } from "react";
import { ActivityIndicator, AppState, StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { boot, connect } from "./src/controller";
import { PairScreen } from "./src/screens/PairScreen";
import { SessionScreen } from "./src/screens/SessionScreen";
import { useBosun } from "./src/store";
import { colors } from "./src/theme";

export default function App() {
  const phase = useBosun((s) => s.phase);

  useEffect(() => {
    void boot();
    // Sockets die in the background; reconnect when we come back.
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void connect();
    });
    return () => sub.remove();
  }, []);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {phase === "boot" ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} size="large" />
        </View>
      ) : phase === "unpaired" ? (
        <PairScreen />
      ) : (
        <SessionScreen />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
