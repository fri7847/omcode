// Context manager — cheapest-first compaction (DESIGN.md §7):
//   Layer 1  snip     — blank out old tool-result bodies, keep structure. 0 tokens.
//   Layer 2  condense — LLM-summarize older turns, keep first exchange + recent
//                       turns intact (OpenHands condenser: quadratic → linear
//                       cost, no accuracy loss).
// The trigger fires BEFORE the request, based on the previous request's real
// prompt token count (ground truth) plus an estimate of newly added text.

import type { ChatMessage } from "../model/provider.js";

export interface ContextConfig {
  numCtx: number;
  /** tokens reserved for the model's output + tool schemas (default 4096) */
  reserve: number;
  /** most-recent messages always kept verbatim (default 8) */
  keepRecent: number;
}

export type CondenseFn = (transcript: string) => Promise<string>;

const SNIP_KEEP_CHARS = 200;
const SNIP_MARK = "[snipped by harness:";

export class ContextManager {
  constructor(
    private cfg: ContextConfig,
    private condense?: CondenseFn,
  ) {}

  /** rough chars→tokens for code-heavy text */
  static estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
  }

  private budget(): number {
    return this.cfg.numCtx - this.cfg.reserve;
  }

  private totalEstimate(messages: ChatMessage[]): number {
    let chars = 0;
    for (const m of messages) chars += m.content.length + 40;
    return Math.ceil(chars / 3.5);
  }

  /**
   * Ensure messages fit the budget. Mutates the array in place.
   * Returns what was done so the UI can report it.
   */
  async ensure(
    messages: ChatMessage[],
    lastPromptTokens: number,
  ): Promise<{ snipped: number; condensed: boolean }> {
    const result = { snipped: 0, condensed: false };
    const over = () =>
      Math.max(lastPromptTokens, this.totalEstimate(messages)) > this.budget();

    if (!over()) return result;

    // ---- Layer 1: snip old tool results (zero token cost) ----
    const protectedFrom = Math.max(1, messages.length - this.cfg.keepRecent);
    for (let i = 1; i < protectedFrom; i++) {
      const m = messages[i]!;
      if (m.role === "tool" && m.content.length > SNIP_KEEP_CHARS + 100 && !m.content.startsWith(SNIP_MARK)) {
        const dropped = m.content.length - SNIP_KEEP_CHARS;
        m.content =
          `${SNIP_MARK} ${dropped} chars removed to save context. Re-run the tool if you need this again.]\n` +
          m.content.slice(0, SNIP_KEEP_CHARS);
        result.snipped++;
        // snipping shrinks the estimate; lastPromptTokens is now stale — rely on estimate
        lastPromptTokens = 0;
        if (!over()) return result;
      }
    }
    if (!over()) return result;

    // ---- Layer 2: condense older turns via LLM ----
    if (!this.condense || messages.length <= this.cfg.keepRecent + 2) return result;

    const head = messages[0]!; // system prompt — never condensed
    const recent = messages.slice(-this.cfg.keepRecent);
    // never split a tool result away from its assistant tool-call message
    while (recent.length > 0 && recent[0]!.role === "tool") {
      recent.unshift(messages[messages.length - recent.length - 1]!);
    }
    const older = messages.slice(1, messages.length - recent.length);
    if (older.length === 0) return result;

    const transcript = older
      .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 1500)}`)
      .join("\n---\n");

    let summary: string;
    try {
      summary = await this.condense(transcript);
    } catch {
      return result; // condensation failure must never break the loop
    }

    messages.length = 0;
    messages.push(
      head,
      {
        role: "user",
        content:
          `[Conversation so far was summarized by the harness to save context]\n${summary}\n` +
          `[End of summary — the messages below are the most recent turns, verbatim]`,
      },
      ...recent,
    );
    result.condensed = true;
    return result;
  }
}

export function condensePrompt(transcript: string): string {
  return (
    `Summarize this coding-agent session transcript for context compression. ` +
    `Structure: Goal / What was done / Files touched (exact paths) / Key facts & decisions (exact names, values, error messages) / What remains. ` +
    `Under 300 words. Preserve exact identifiers — they cannot be recovered once lost.\n\n${transcript}`
  );
}
