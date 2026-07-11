// Per-model-family profiles. Open models differ at the harness boundary
// (thinking vs not, native-tool-call reliability), so a small profile registry
// sets a sensible `think` default and layers a short family-specific note into
// the system prompt (OpenCode's per-provider-prompt lesson).
//
// Deliberately conservative: an unknown model gets the generic profile and the
// harness behaves exactly as before. Extend the table as models are characterized.

export interface ModelProfile {
  /** family label (for display / debugging) */
  family: string;
  /**
   * Default reasoning toggle when the user has NOT set OMCODE_THINK / config.think.
   * undefined = leave to the server default (don't send `think`). Only set for
   * families confirmed to accept it, so we never send `think` to a model that
   * would reject it.
   */
  think?: boolean;
  /** short guidance appended to the system prompt for this family */
  systemAddendum?: string;
}

// Weaker tool-callers benefit from reinforcing the base prompt's tool rule —
// low risk (it only restates an existing instruction) and measurably helps.
const WEAK_TOOLING =
  "\n\n# Note for this model\n" +
  "- Emit every tool call ONLY through the tool-calling interface — never as text, JSON, or XML in your reply.\n" +
  "- Make one tool call at a time and read its result before the next.";

// First match wins. Order matters: more specific patterns before general ones.
const TABLE: Array<[RegExp, ModelProfile]> = [
  // Qwen coder variants are non-thinking, strong tool-callers.
  [/qwen[\w.]*-?coder/i, { family: "qwen-coder" }],
  // Qwen3/3.5 chat models are thinking models; default thinking OFF for a
  // faster harness loop (confirmed to accept think:false). Users can opt in.
  [/qwen3/i, { family: "qwen", think: false }],
  // DeepSeek R1 / reasoning models always reason — leave `think` to the server.
  [/deepseek[-\w.]*(r1|reason)/i, { family: "deepseek-r1" }],
  [/deepseek/i, { family: "deepseek" }],
  // Agent-tuned, strong tool callers.
  [/devstral|mistral|ministral|magistral|minimax/i, { family: "mistral" }],
  [/gpt-?oss/i, { family: "gpt-oss" }],
  [/kimi|glm|nemotron/i, { family: "large-mixed" }],
  // Historically weaker at tool calling — reinforce the tool rule.
  [/gemma/i, { family: "gemma", systemAddendum: WEAK_TOOLING }],
  [/llama|phi|smollm|tinyllama|granite|qwen2/i, { family: "small", systemAddendum: WEAK_TOOLING }],
];

export function profileFor(model: string): ModelProfile {
  for (const [re, profile] of TABLE) if (re.test(model)) return profile;
  return { family: "generic" };
}
