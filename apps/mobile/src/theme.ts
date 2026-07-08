export const colors = {
  bg: "#0E1116",
  surface: "#161B22",
  surfaceRaised: "#1F2630",
  border: "#2D3541",
  text: "#E6EDF3",
  textDim: "#8B949E",
  accent: "#4C8DFF",
  ok: "#3FB950",
  warn: "#D29922",
  danger: "#F85149",
} as const;

export const statusColor: Record<string, string> = {
  starting: colors.textDim,
  running: colors.accent,
  awaiting_permission: colors.warn,
  idle: colors.ok,
  error: colors.danger,
  exited: colors.textDim,
};
