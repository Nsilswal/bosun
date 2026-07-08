import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { parseQr } from "../connection";
import { pair } from "../controller";
import { useBosun } from "../store";
import { colors } from "../theme";

export function PairScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [manual, setManual] = useState(false);
  const [manualAddr, setManualAddr] = useState("");
  const [manualToken, setManualToken] = useState("");
  const scanned = useRef(false);
  const connError = useBosun((s) => s.connError);

  const onScan = useCallback(async (data: string) => {
    if (scanned.current) return;
    const qr = parseQr(data);
    if (!qr) return; // not a Bosun QR; keep scanning
    scanned.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await pair(qr);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      scanned.current = false;
    } finally {
      setBusy(false);
    }
  }, []);

  const onManualPair = useCallback(async () => {
    const [host, portRaw] = manualAddr.trim().split(":");
    const port = Number(portRaw);
    if (!host || !Number.isFinite(port)) {
      setError("enter host:port, e.g. 192.168.1.10:45450");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      // Trust-on-first-use: no pinned key; the handshake records the
      // supervisor key we actually connected to.
      await pair({
        bosun: 1,
        name: host,
        addrs: [{ host, port }],
        supervisorPublicKey: "",
        pairingToken: manualToken.trim(),
        expiresAt: Date.now() + 60_000,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [manualAddr, manualToken]);

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Pair with your supervisor</Text>
      <Text style={styles.sub}>
        Run <Text style={styles.code}>npx bosun</Text> on your machine and scan
        the QR code it prints.
      </Text>

      {!manual && (
        <View style={styles.cameraBox}>
          {permission?.granted ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={({ data }) => void onScan(data)}
            />
          ) : (
            <Pressable
              style={styles.permBtn}
              onPress={() => void requestPermission()}
            >
              <Text style={styles.permBtnText}>Enable camera</Text>
            </Pressable>
          )}
          {busy && (
            <View style={styles.busyOverlay}>
              <ActivityIndicator color={colors.accent} size="large" />
              <Text style={styles.busyText}>Pairing…</Text>
            </View>
          )}
        </View>
      )}

      {manual && (
        <View style={styles.manualBox}>
          <TextInput
            style={styles.input}
            placeholder="host:port (e.g. 192.168.1.10:45450)"
            placeholderTextColor={colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            value={manualAddr}
            onChangeText={setManualAddr}
          />
          <TextInput
            style={styles.input}
            placeholder="pairing token (printed by the supervisor)"
            placeholderTextColor={colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            value={manualToken}
            onChangeText={setManualToken}
          />
          <Pressable
            style={[styles.permBtn, busy && { opacity: 0.5 }]}
            disabled={busy}
            onPress={() => void onManualPair()}
          >
            <Text style={styles.permBtnText}>
              {busy ? "Pairing…" : "Pair"}
            </Text>
          </Pressable>
        </View>
      )}

      {(error ?? connError) && (
        <Text style={styles.error}>{error ?? connError}</Text>
      )}

      <Pressable onPress={() => setManual((m) => !m)}>
        <Text style={styles.toggle}>
          {manual ? "Scan a QR code instead" : "Enter address manually"}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: 24,
    paddingTop: 80,
    gap: 16,
  },
  title: { color: colors.text, fontSize: 26, fontWeight: "700" },
  sub: { color: colors.textDim, fontSize: 15, lineHeight: 22 },
  code: { fontFamily: "Menlo", color: colors.accent },
  cameraBox: {
    height: 320,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  busyOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#0009",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  busyText: { color: colors.text, fontSize: 16 },
  permBtn: {
    backgroundColor: colors.accent,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
  },
  permBtnText: { color: "#fff", fontWeight: "600", fontSize: 16 },
  manualBox: { gap: 12 },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    color: colors.text,
    padding: 14,
    fontSize: 15,
    fontFamily: "Menlo",
  },
  error: { color: colors.danger, fontSize: 14 },
  toggle: { color: colors.accent, fontSize: 15, textAlign: "center" },
});
