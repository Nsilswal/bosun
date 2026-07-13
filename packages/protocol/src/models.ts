/**
 * Models a client may pick when starting a session. The `id` is passed straight
 * to the Claude Agent SDK's `model` option (an alias it understands); the
 * special `DEFAULT_MODEL_ID` means "send no model" so the supervisor inherits
 * whatever the machine's Claude Code is configured to use.
 *
 * The SDK accepts any alias or full model id, so this list is a curated menu for
 * the UI — not an exhaustive allowlist. Keep it in sync with the aliases Claude
 * Code ships.
 */

export const DEFAULT_MODEL_ID = "default";

export interface ModelOption {
  /** Alias sent to the SDK, or DEFAULT_MODEL_ID to inherit the machine default. */
  id: string;
  label: string;
}

export const MODEL_OPTIONS: readonly ModelOption[] = [
  { id: DEFAULT_MODEL_ID, label: "Default" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
] as const;

/**
 * Normalize a picked model id into the value to send over the wire: undefined
 * for the machine default, otherwise the alias itself.
 */
export function resolveModel(id: string | undefined): string | undefined {
  if (id === undefined || id === DEFAULT_MODEL_ID) return undefined;
  return id;
}
