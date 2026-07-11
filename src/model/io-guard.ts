// io-guard — the model I/O defense layer (DESIGN.md §4).
// Every harness we studied fails first at this boundary. Rules:
//
// 1. Strip <think>…</think> before any parsing (reasoning models leak these
//    into the output stream and corrupt parsers — aider/r1 lesson).
// 2. If the provider returned no native tool calls, try to RECOVER calls the
//    model wrote as text: Hermes-style <tool_call> XML, then bare/fenced JSON
//    objects shaped like {"name": …, "arguments": …}. Zero-token absorption.
// 3. Classify "empty" responses into three distinct cases (Qwen Code #2402/#2530
//    got this wrong and broke): tool-call turn (normal), empty end-turn after
//    tool results (normal), genuinely empty (provider failure).

import type { ChatResult, ToolCall } from "./provider.js";

export interface GuardedResult {
  /** assistant text with think blocks + recovered-call fragments removed */
  content: string;
  toolCalls: ToolCall[];
  /** how the tool calls were obtained */
  toolCallSource: "native" | "recovered-xml" | "recovered-json" | "none";
  /** classification of the turn */
  kind: "tool-calls" | "text" | "empty-end-turn" | "degenerate";
}

let recoverSeq = 0;

export function guard(result: ChatResult): GuardedResult {
  let content = stripThink(result.content);

  // Degenerate output ("0000000…", token-salad loops) means the model runtime
  // itself is broken — observed live when an 8GB-VRAM CPU/GPU-split instance
  // corrupted mid-benchmark. No retry can fix this; surface it immediately.
  if (result.toolCalls.length === 0 && isDegenerate(content)) {
    return { content: "", toolCalls: [], toolCallSource: "none", kind: "degenerate" };
  }

  if (result.toolCalls.length > 0) {
    return {
      content: content.trim(),
      toolCalls: result.toolCalls,
      toolCallSource: "native",
      kind: "tool-calls",
    };
  }

  // Recovery ladder — cheapest first, all zero extra tokens.
  const xml = recoverFromXml(content);
  if (xml.calls.length > 0) {
    return {
      content: xml.rest.trim(),
      toolCalls: xml.calls,
      toolCallSource: "recovered-xml",
      kind: "tool-calls",
    };
  }

  const json = recoverFromJson(content);
  if (json.calls.length > 0) {
    return {
      content: json.rest.trim(),
      toolCalls: json.calls,
      toolCallSource: "recovered-json",
      kind: "tool-calls",
    };
  }

  content = content.trim();
  return {
    content,
    toolCalls: [],
    toolCallSource: "none",
    kind: content.length === 0 ? "empty-end-turn" : "text",
  };
}

/**
 * Detect degenerate generation: a wedged runtime emits long single-char runs
 * or a short token repeated endlessly. Conservative thresholds — normal code
 * (separator comments, ASCII art) must never trip this.
 */
export function isDegenerate(text: string): boolean {
  const t = text.trim();
  if (t.length < 80) return false;
  // one character repeated 60+ times consecutively
  if (/(.)\1{59,}/.test(t)) return true;
  // very low character diversity over a long output
  if (t.length >= 200 && new Set(t.replace(/\s/g, "")).size <= 3) return true;
  // a short token repeated 25+ times in a row (with whitespace between)
  if (/(\S{1,12})(?:\s+\1){24,}/.test(t)) return true;
  return false;
}

/** Remove <think>/<thinking> blocks, including an unclosed trailing one. */
export function stripThink(text: string): string {
  let out = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
  // Unclosed trailing think block (model got cut off or forgot to close)
  out = out.replace(/<think(?:ing)?>[\s\S]*$/i, "");
  return out;
}

/** Hermes-style: <tool_call>{"name": "...", "arguments": {...}}</tool_call> */
function recoverFromXml(text: string): { calls: ToolCall[]; rest: string } {
  const calls: ToolCall[] = [];
  const rest = text.replace(
    /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi,
    (_m, inner: string) => {
      const call = parseCallObject(inner);
      if (call) calls.push(call);
      return "";
    },
  );
  return { calls, rest };
}

/**
 * Recover a call the model wrote as a JSON object in plain text or a fenced
 * block. Conservative: only objects that have BOTH "name" and
 * "arguments"/"parameters" keys, to avoid eating ordinary JSON in prose.
 */
function recoverFromJson(text: string): { calls: ToolCall[]; rest: string } {
  const calls: ToolCall[] = [];
  let rest = text;

  // Fenced blocks first: ```json ... ```
  rest = rest.replace(/```(?:json)?\s*([\s\S]*?)```/g, (m, inner: string) => {
    const call = parseCallObject(inner);
    if (call) {
      calls.push(call);
      return "";
    }
    return m; // not a tool call — leave the fence alone
  });

  if (calls.length === 0) {
    // Bare top-level JSON object covering (almost) the whole message
    const trimmed = rest.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      const call = parseCallObject(trimmed);
      if (call) {
        calls.push(call);
        rest = "";
      }
    }
  }
  return { calls, rest };
}

function parseCallObject(s: string): ToolCall | null {
  let obj: unknown;
  try {
    obj = JSON.parse(s.trim());
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const name = o["name"];
  const args = o["arguments"] ?? o["parameters"];
  if (typeof name !== "string" || name.length === 0) return null;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return null;
  }
  return {
    id: `rec_${++recoverSeq}`,
    name,
    arguments: args as Record<string, unknown>,
  };
}
