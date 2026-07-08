import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/**
 * Best-effort push registration. Requires a physical device and an EAS
 * projectId (present once `eas init` has run); silently skips otherwise so
 * the app works fully over the live connection without push.
 */
export async function registerForPush(
  onToken: (expoPushToken: string) => void,
): Promise<void> {
  try {
    if (!Device.isDevice) return;
    const projectId: string | undefined =
      Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return;

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Escalations",
        importance: Notifications.AndroidImportance.MAX,
      });
    }
    const perm = await Notifications.requestPermissionsAsync();
    if (perm.status !== "granted") return;

    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    onToken(token.data);
  } catch (err) {
    console.warn("push registration skipped:", err);
  }
}
