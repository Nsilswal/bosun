/**
 * Expo push notifications. Deliberately content-free: pushes route through
 * Expo's servers, so the payload never contains tool names, commands, or
 * paths — those travel only over the encrypted transport. The push is just a
 * doorbell; the app fetches real state when opened.
 */
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export async function sendEscalationPush(tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  try {
    await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        tokens.map((to) => ({
          to,
          title: "Bosun",
          body: "An agent is waiting for your approval",
          priority: "high",
        })),
      ),
    });
  } catch (err) {
    console.error("push notification failed:", err);
  }
}
