// Loop breaker — detection that actually INTERVENES (Gemini CLI detected a
// 1,039-iteration loop, warned, and could not stop it — #25671).
// Escalation ladder, ordered by token cost:
//   2nd identical call → warning appended to the tool result (small nudge)
//   3rd identical call → turn is force-stopped (hard cost ceiling)

import { createHash } from "node:crypto";
import type { ToolCall } from "../model/provider.js";

export type LoopVerdict =
  | { action: "proceed" }
  | { action: "nudge"; note: string }
  | { action: "halt"; reason: string };

export class LoopBreaker {
  private counts = new Map<string, number>();

  /** Call once per tool call, before execution. */
  check(call: ToolCall): LoopVerdict {
    const key = hash(call);
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);

    if (n === 2) {
      return {
        action: "nudge",
        note:
          `\n\n[WARNING: this is the 2nd time you called ${call.name} with exactly these arguments. ` +
          `Repeating it will return the same result. Change your approach: different arguments, a different tool, or ask the user.]`,
      };
    }
    if (n >= 3) {
      return {
        action: "halt",
        reason:
          `Stopped: "${call.name}" was called 3 times with identical arguments — the model is looping. ` +
          `Last arguments: ${JSON.stringify(call.arguments).slice(0, 200)}`,
      };
    }
    return { action: "proceed" };
  }

  /** Reset when a new user message arrives (a new instruction breaks the pattern). */
  reset(): void {
    this.counts.clear();
  }
}

function hash(call: ToolCall): string {
  const normalized = JSON.stringify({
    name: call.name,
    args: sortKeys(call.arguments),
  });
  return createHash("sha1").update(normalized).digest("hex");
}

function sortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (typeof obj === "object" && obj !== null) {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return obj;
}
