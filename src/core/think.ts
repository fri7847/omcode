// Reasoning-effort levels for /think. Open models rarely expose a universal
// "reasoning_effort" API, so effort is implemented two ways that work
// everywhere: (1) the hard on/off `think` flag Ollama already understands, and
// (2) a system-prompt effort hint that nudges a thinking model to deliberate
// more or less. `off` is the only hard switch; the rest are soft, and models
// with no reasoning (e.g. coder variants) simply ignore the hint.

export type ThinkLevel = "off" | "low" | "medium" | "high" | "xhigh";

const LEVELS: readonly string[] = ["off", "low", "medium", "high", "xhigh"];

/** Parse a level, accepting "ultra" as an alias for the maximum (xhigh). */
export function parseThinkLevel(value: string | undefined): ThinkLevel | undefined {
  if (value === "ultra") return "xhigh";
  return value && LEVELS.includes(value) ? (value as ThinkLevel) : undefined;
}

/** Whether the model should reason at all (the hard Ollama `think` flag). */
export function thinkOn(level: ThinkLevel): boolean {
  return level !== "off";
}

/** System-prompt section that scales deliberation. Empty for off. */
export function effortSection(level: ThinkLevel): string {
  switch (level) {
    case "off":
      return "";
    case "low":
      return "\n\n# Reasoning effort: low\n- Answer directly with minimal deliberation.";
    case "medium":
      return "\n\n# Reasoning effort: medium\n- Think through the key steps before answering.";
    case "high":
      return "\n\n# Reasoning effort: high\n- Deliberate carefully — weigh edge cases and alternatives before answering.";
    case "xhigh":
      return "\n\n# Reasoning effort: maximum (ultra)\n- Think exhaustively: enumerate approaches, check edge cases and failure modes, verify your reasoning, then answer.";
  }
}
