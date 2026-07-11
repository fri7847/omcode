// Ollama provider — works for both local (http://localhost:11434) and
// Ollama Cloud (https://ollama.com + OLLAMA_API_KEY). Same /api/chat API.
//
// io-guard rules applied here:
// - num_ctx is ALWAYS set explicitly (silent truncation collapsed Qwen 32B
//   from 72%→52% in aider's measurements — never trust server defaults)
// - hard request timeout via AbortController (open-model providers stall
//   without erroring — Qwen Code had to add this after forking Gemini CLI)

import {
  InterruptedError,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type Provider,
  type ToolCall,
} from "./provider.js";

interface OllamaOptions {
  host: string;
  apiKey?: string;
  /** overall request timeout in ms (default 300s — big cloud models are slow) */
  timeoutMs?: number;
}

interface OllamaToolCall {
  function?: { name?: string; arguments?: Record<string, unknown> | string };
}

interface OllamaChatResponse {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/**
 * Streaming chunk accumulator — pure and unit-testable, because delta
 * accumulation is where forks break (Qwen Code #2402: a duplicate empty
 * finish chunk CLOBBERED the accumulated tool calls). Rules:
 *  - only ever APPEND content and tool calls, never replace
 *  - on any finish chunk, merge usage/done_reason without touching content
 */
export class StreamAccumulator {
  content = "";
  toolCalls: OllamaToolCall[] = [];
  doneReason = "unknown";
  promptTokens = 0;
  completionTokens = 0;

  add(chunk: OllamaChatResponse): { textDelta: string } {
    let textDelta = "";
    if (chunk.message?.content) {
      textDelta = chunk.message.content;
      this.content += textDelta;
    }
    if (chunk.message?.tool_calls?.length) {
      this.toolCalls.push(...chunk.message.tool_calls);
    }
    if (chunk.done) {
      if (chunk.done_reason) this.doneReason = chunk.done_reason;
      // duplicate finish chunks: take the max, never reset to 0
      this.promptTokens = Math.max(this.promptTokens, chunk.prompt_eval_count ?? 0);
      this.completionTokens = Math.max(this.completionTokens, chunk.eval_count ?? 0);
    }
    return { textDelta };
  }
}

let callSeq = 0;

export class OllamaProvider implements Provider {
  readonly name = "ollama";
  private host: string;
  private apiKey?: string;
  private timeoutMs: number;

  constructor(opts: OllamaOptions) {
    this.host = opts.host.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(toOllamaMessage),
      tools: req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
      stream: false,
      options:
        req.maxOutput !== undefined
          ? { num_ctx: req.numCtx, num_predict: req.maxOutput }
          : { num_ctx: req.numCtx },
    };
    if (req.think !== undefined) body["think"] = req.think;

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;

    if (req.onDelta) {
      body["stream"] = true;
      return this.chatStreaming(body, headers, req);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    req.signal?.addEventListener("abort", onExternalAbort, { once: true });
    let res: Response;
    try {
      res = await fetch(`${this.host}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (req.signal?.aborted) throw new InterruptedError();
      if (controller.signal.aborted) {
        throw new Error(
          `ollama request timed out after ${this.timeoutMs / 1000}s (model=${req.model}, host=${this.host})`,
        );
      }
      throw new Error(
        `ollama request failed (host=${this.host}): ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onExternalAbort);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `ollama HTTP ${res.status} (model=${req.model}): ${truncate(text, 500)}`,
      );
    }

    let data: OllamaChatResponse;
    try {
      data = JSON.parse(text) as OllamaChatResponse;
    } catch {
      throw new Error(`ollama returned non-JSON response: ${truncate(text, 300)}`);
    }
    if (data.error) throw new Error(`ollama error: ${data.error}`);

    return {
      content: data.message?.content ?? "",
      toolCalls: (data.message?.tool_calls ?? [])
        .map(toToolCall)
        .filter((c): c is ToolCall => c !== null),
      doneReason: data.done_reason ?? "unknown",
      usage: {
        promptTokens: data.prompt_eval_count ?? 0,
        completionTokens: data.eval_count ?? 0,
      },
    };
  }

  /** Model names available on this host (empty array if the endpoint fails). */
  async listModels(): Promise<string[]> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    try {
      const res = await fetch(`${this.host}/api/tags`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return [];
      const data = (await res.json()) as { models?: { name?: string; model?: string }[] };
      return (data.models ?? [])
        .map((m) => m.name ?? m.model ?? "")
        .filter((n) => n.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * NDJSON streaming path with a true INACTIVITY timeout — the timer resets
   * on every chunk, so a slow-but-alive generation is fine while a silent
   * stall (open-model providers do this without erroring) aborts cleanly.
   */
  private async chatStreaming(
    body: Record<string, unknown>,
    headers: Record<string, string>,
    req: ChatRequest,
  ): Promise<ChatResult> {
    const inactivityMs = 90_000;
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), inactivityMs);
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), inactivityMs);
    };
    const onExternalAbort = () => controller.abort();
    req.signal?.addEventListener("abort", onExternalAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onExternalAbort);
    };

    let res: Response;
    try {
      res = await fetch(`${this.host}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      cleanup();
      if (req.signal?.aborted) throw new InterruptedError();
      if (controller.signal.aborted) {
        throw new Error(`ollama stream: no response within ${inactivityMs / 1000}s (model=${req.model})`);
      }
      throw new Error(`ollama request failed (host=${this.host}): ${(err as Error).message}`);
    }

    if (!res.ok || !res.body) {
      cleanup();
      const text = await res.text().catch(() => "");
      throw new Error(`ollama HTTP ${res.status} (model=${req.model}): ${truncate(text, 500)}`);
    }

    const acc = new StreamAccumulator();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bump();
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let chunk: OllamaChatResponse;
          try {
            chunk = JSON.parse(line) as OllamaChatResponse;
          } catch {
            continue; // partial/garbled line — never crash mid-stream
          }
          if (chunk.error) throw new Error(`ollama error: ${chunk.error}`);
          const { textDelta } = acc.add(chunk);
          if (textDelta) req.onDelta!(textDelta);
        }
      }
    } catch (err) {
      if (req.signal?.aborted) throw new InterruptedError();
      if (controller.signal.aborted) {
        throw new Error(
          `ollama stream stalled: no data for ${inactivityMs / 1000}s (model=${req.model}). ` +
            `Partial content received: ${acc.content.length} chars.`,
        );
      }
      throw err;
    } finally {
      cleanup();
    }

    return {
      content: acc.content,
      toolCalls: acc.toolCalls.map(toToolCall).filter((c): c is ToolCall => c !== null),
      doneReason: acc.doneReason,
      usage: { promptTokens: acc.promptTokens, completionTokens: acc.completionTokens },
    };
  }
}

function toOllamaMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.toolCalls?.length) {
    out["tool_calls"] = m.toolCalls.map((c) => ({
      function: { name: c.name, arguments: c.arguments },
    }));
  }
  if (m.role === "tool" && m.toolName) out["tool_name"] = m.toolName;
  return out;
}

function toToolCall(raw: OllamaToolCall): ToolCall | null {
  const name = raw.function?.name;
  if (!name) return null;
  let args = raw.function?.arguments ?? {};
  // Some servers return arguments as a JSON string — absorb at zero token cost.
  if (typeof args === "string") {
    try {
      args = JSON.parse(args) as Record<string, unknown>;
    } catch {
      args = { _raw: args };
    }
  }
  return { id: `call_${++callSeq}`, name, arguments: args };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
