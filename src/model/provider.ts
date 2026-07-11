// Provider abstraction — the LLM is a swappable component (Crush lesson).
// Phase 0: non-streaming only (buffer-then-parse; streaming tool-call chunk
// loss is the #1 reported bug across OpenCode/Crush/vLLM — DESIGN.md §4.1).

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  /** for role:"tool" — which tool produced this result */
  toolName?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the arguments object */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  numCtx: number;
  /**
   * Reasoning toggle for thinking models (qwen3, deepseek-r1 …).
   * undefined = server default. false cuts latency/tokens sharply on small
   * models — part of the model profile, not a global setting.
   */
  think?: boolean;
  /**
   * Live text preview. When set, the provider streams and calls this per
   * text delta. The RETURNED ChatResult is always the authoritative,
   * fully-buffered response (buffer-then-parse still applies to tool calls
   * — streamed deltas are preview only, like Managed Agents' event_delta).
   */
  onDelta?: (text: string) => void;
  /** external abort (esc-to-interrupt) — cancels the in-flight request */
  signal?: AbortSignal;
}

/** Thrown when a turn is interrupted by the user (esc). */
export class InterruptedError extends Error {
  constructor() {
    super("interrupted");
    this.name = "InterruptedError";
  }
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResult {
  /** assistant text (may be empty on a tool-call-only turn — that is normal) */
  content: string;
  /** native tool calls as returned by the provider */
  toolCalls: ToolCall[];
  doneReason: string;
  usage: ChatUsage;
}

export interface Provider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResult>;
}
