// The agent loop — Claude Code's proven shape: while(tool_call) over a flat,
// append-only message list. No planner, no graph. The harness's job is to
// absorb model mistakes at the lowest possible token cost (DESIGN.md §1).

import { InterruptedError, type ChatMessage, type Provider, type ToolCall } from "../model/provider.js";
import { guard } from "../model/io-guard.js";
import type { ToolRegistry, ToolContext, ToolPreview } from "../tools/registry.js";
import { LoopBreaker } from "../policy/loop-breaker.js";
import type { SessionLog } from "./session.js";
import type { ContextManager } from "./context.js";
import { blocksTool, autoAccepts, type AgentMode } from "./agent-mode.js";
import { modeSection } from "../prompt/system.js";
import { thinkOn, effortSection, type ThinkLevel } from "./think.js";

export type PermissionDecision = "yes" | "always" | "no";

export interface LoopUI {
  onAssistantText(text: string): void;
  /** fires per streamed chunk — drives the live spinner token counter */
  onAssistantDelta?(text: string): void;
  /** brackets each model request (network wait) for the spinner */
  onThinkingStart?(): void;
  onThinkingStop?(): void;
  onToolStart(call: ToolCall, source: string): void;
  /** show the proposed change (diff / command) before it runs */
  onToolPreview?(call: ToolCall, preview: ToolPreview): void;
  onToolEnd(call: ToolCall, result: string, isError: boolean): void;
  onNotice(message: string): void;
  askPermission(call: ToolCall): Promise<PermissionDecision>;
}

export interface LoopConfig {
  model: string;
  numCtx: number;
  maxToolCallsPerTurn: number;
  /** on/off reasoning flag (used by subagents that don't set a level) */
  think?: boolean;
  /** reasoning-effort level; when set it drives `think` and the effort prompt */
  thinkLevel?: ThinkLevel;
  /** hard output-token cap (Ollama num_predict); undefined = no cap */
  maxOutput?: number;
  /** Defaults to check (ask-before-mutating) for programmatic callers. */
  mode?: AgentMode;
}

export interface TurnStats {
  requests: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  recoveredCalls: number;
  /** prompt-token count of the LAST request — the live context-window size */
  lastPromptTokens: number;
}

/** Append-only session logger; subagents use an in-memory no-op sink. */
export interface SessionSink {
  append(type: string, data?: Record<string, unknown>): void;
}

export class AgentLoop {
  readonly messages: ChatMessage[] = [];
  private breaker = new LoopBreaker();
  private lastPromptTokens = 0;
  /** tools the user chose "always allow" for this session */
  private alwaysAllowed = new Set<string>();
  private systemPrompt: string;

  constructor(
    private provider: Provider,
    private registry: ToolRegistry,
    private config: LoopConfig,
    private ui: LoopUI,
    private session: SessionSink,
    private toolCtx: ToolContext,
    systemPrompt: string,
    private contextMgr?: ContextManager,
    resumeMessages?: ChatMessage[],
  ) {
    this.systemPrompt = systemPrompt;
    if (resumeMessages && resumeMessages.length > 0) {
      this.messages.push(...resumeMessages);
      this.session.append("resumed", { messageCount: resumeMessages.length });
    } else {
      this.messages.push({ role: "system", content: systemPrompt });
      this.session.append("system", { content: systemPrompt });
    }
  }

  /** Reset the conversation to a fresh state, keeping the system prompt + mode
   * (the /clear command). The session log records a marker so resume replays it. */
  clear(): void {
    this.messages.length = 0;
    this.messages.push({
      role: "system",
      content: this.systemPrompt + modeSection(this.config.mode ?? "ask"),
    });
    this.breaker.reset();
    this.lastPromptTokens = 0;
    this.session.append("cleared", {});
  }

  /** Force context condensation now (the /compact command). No-op without a
   * context manager or when there is nothing old enough to summarize. */
  async compactNow(): Promise<{ condensed: boolean; before: number; after: number }> {
    if (!this.contextMgr) return { condensed: false, before: 0, after: 0 };
    return this.contextMgr.compact(this.messages);
  }

  /** Start a brand-new conversation logged to a fresh session (the /new command).
   * Unlike /clear it also switches the session file, so the old transcript is
   * closed and resume points at the new one. */
  newSession(session: SessionSink): void {
    this.session = session;
    this.messages.length = 0;
    const content = this.systemPrompt + modeSection(this.config.mode ?? "ask");
    this.messages.push({ role: "system", content });
    this.breaker.reset();
    this.lastPromptTokens = 0;
    this.session.append("system", { content });
  }

  /** Tool permission overview for /permissions. */
  toolPermissions(): { name: string; permission: string; readOnly: boolean; always: boolean }[] {
    return this.registry.list().map((t) => ({
      name: t.name,
      permission: t.permission,
      readOnly: t.readOnly,
      always: this.alwaysAllowed.has(t.name),
    }));
  }

  /** Current reasoning-effort level (the /think command). */
  getThinkLevel(): ThinkLevel {
    return this.config.thinkLevel ?? "off";
  }

  /** Set the reasoning-effort level: drives the `think` flag and swaps the
   * effort section in the system prompt for subsequent requests. */
  setThinkLevel(level: ThinkLevel): void {
    this.config.thinkLevel = level;
    const system = this.messages.find((message) => message.role === "system");
    if (system) {
      // strip the existing (bounded) effort block, then append the new one
      system.content =
        system.content.replace(/\n\n# Reasoning effort:[^\n]*(?:\n-[^\n]*)*/, "") + effortSection(level);
    }
    this.session.append("thinkLevel", { level });
  }

  /** Set a session-scope permission override (/permissions allow|ask <tool>).
   * Returns false if the tool name is unknown. */
  setToolAlways(name: string, always: boolean): boolean {
    if (!this.registry.get(name)) return false;
    if (always) this.alwaysAllowed.add(name);
    else this.alwaysAllowed.delete(name);
    return true;
  }

  setMode(mode: AgentMode): void {
    this.config.mode = mode;
    const system = this.messages.find((message) => message.role === "system");
    if (system) {
      // Replace our own tagged section rather than continually appending
      // instructions as the user switches modes during a long session.
      // bounded (bullets only) so it doesn't swallow a trailing effort section
      system.content = system.content.replace(/\n\n# Active mode: (?:read|ask|auto)(?:\n-[^\n]*)*/, "") + modeSection(mode);
    } else {
      this.messages.unshift({ role: "system", content: this.systemPrompt + modeSection(mode) });
    }
    this.session.append("mode", { mode });
  }

  async runTurn(userInput: string, signal?: AbortSignal): Promise<TurnStats> {
    this.breaker.reset();
    this.messages.push({ role: "user", content: userInput });
    this.session.append("user", { content: userInput });

    const stats: TurnStats = {
      requests: 0,
      toolCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      recoveredCalls: 0,
      lastPromptTokens: 0,
    };

    while (true) {
      // Compaction runs BEFORE the request, cheapest layer first.
      if (this.contextMgr) {
        const c = await this.contextMgr.ensure(this.messages, this.lastPromptTokens);
        if (c.snipped > 0) this.ui.onNotice(`context: snipped ${c.snipped} old tool result(s)`);
        if (c.condensed) this.ui.onNotice(`context: older turns condensed into a summary`);
      }

      const onDelta = this.ui.onAssistantDelta
        ? (t: string) => this.ui.onAssistantDelta!(t)
        : undefined;

      this.ui.onThinkingStart?.();
      let result;
      try {
        result = await this.provider.chat({
          model: this.config.model,
          messages: this.messages,
          tools: this.registry.schemas(),
          numCtx: this.config.numCtx,
          think: this.config.thinkLevel !== undefined ? thinkOn(this.config.thinkLevel) : this.config.think,
          maxOutput: this.config.maxOutput,
          onDelta,
          signal,
        });
      } catch (err) {
        if (err instanceof InterruptedError) {
          this.ui.onThinkingStop?.();
          this.ui.onNotice("중단됨 (esc)");
          // record a placeholder so history stays consistent for the next turn
          this.messages.push({ role: "assistant", content: "[interrupted by user]" });
          this.session.append("interrupted", {});
          return stats;
        }
        throw err;
      } finally {
        this.ui.onThinkingStop?.();
      }
      stats.requests++;
      stats.promptTokens += result.usage.promptTokens;
      stats.completionTokens += result.usage.completionTokens;
      stats.lastPromptTokens = result.usage.promptTokens;
      this.lastPromptTokens = result.usage.promptTokens;

      const guarded = guard(result);

      if (guarded.kind === "degenerate") {
        this.session.append("degenerate", { rawLength: result.content.length });
        this.ui.onNotice(
          "model produced degenerate output (repeating garbage) — the model runtime is likely wedged. " +
            "Turn stopped. Try reloading the model (e.g. `ollama stop <model>`), then continue.",
        );
        return stats;
      }
      this.session.append("assistant", {
        content: guarded.content,
        toolCalls: guarded.toolCalls,
        source: guarded.toolCallSource,
        doneReason: result.doneReason,
      });

      // Truncation: the response hit the output limit and is incomplete — a cut
      // tool call or half-written file would otherwise be used silently.
      if (result.doneReason === "length") {
        this.ui.onNotice(
          "response was cut off at the output limit — it may be incomplete. " +
            "Raise num_ctx / OMCODE_MAX_OUTPUT, or split the task into smaller steps.",
        );
      }

      if (guarded.toolCallSource.startsWith("recovered")) {
        stats.recoveredCalls += guarded.toolCalls.length;
        this.ui.onNotice(
          `tool call recovered from text (${guarded.toolCallSource}) — model did not use native tool calling`,
        );
      }

      // Deltas only drove the spinner counter; the authoritative buffered text
      // is printed here (buffer-then-parse — never render partial tool calls).
      if (guarded.content) this.ui.onAssistantText(guarded.content);

      // History gets the guarded view (think-stripped, calls normalized).
      this.messages.push({
        role: "assistant",
        content: guarded.content,
        toolCalls: guarded.toolCalls.length ? guarded.toolCalls : undefined,
      });

      if (guarded.kind !== "tool-calls") {
        // "empty-end-turn" after tool results is a NORMAL end (Qwen Code
        // lesson: do not treat it as an error). Genuinely empty first
        // response is a provider anomaly worth surfacing.
        if (guarded.kind === "empty-end-turn" && stats.toolCalls === 0) {
          this.ui.onNotice(
            "model returned an empty response with no tool calls (provider anomaly?)",
          );
        }
        return stats;
      }

      if (stats.toolCalls + guarded.toolCalls.length > this.config.maxToolCallsPerTurn) {
        this.ui.onNotice(
          `turn stopped: exceeded ${this.config.maxToolCallsPerTurn} tool calls (budget ceiling)`,
        );
        return stats;
      }

      // Execute sequentially in Phase 0 (read-parallelism is a Phase 1 win).
      for (const call of guarded.toolCalls) {
        stats.toolCalls++;
        const outcome = await this.executeCall(call);
        this.messages.push({ role: "tool", content: outcome.result, toolName: call.name });
        // full result in the log — it is already capped, and resume needs it verbatim
        this.session.append("tool", { name: call.name, result: outcome.result });
        if (outcome.halt) {
          this.ui.onNotice(outcome.halt);
          return stats;
        }
      }
    }
  }

  private async executeCall(
    call: ToolCall,
  ): Promise<{ result: string; halt?: string }> {
    // 1. Loop breaker BEFORE anything else — cheapest place to stop a loop.
    const verdict = this.breaker.check(call);
    if (verdict.action === "halt") {
      return {
        result: `[turn stopped by harness: ${verdict.reason}]`,
        halt: verdict.reason,
      };
    }

    // The call is happening — show it before we validate/gate/execute.
    this.ui.onToolStart(call, call.id);

    // 2. Schema validation — error text is a self-correction guide.
    const validated = this.registry.validate(call.name, call.arguments);
    if (!validated.ok) {
      this.ui.onToolEnd(call, validated.error, true);
      return { result: validated.error };
    }
    const tool = this.registry.get(call.name)!;

    const mode = this.config.mode ?? "ask";
    if (blocksTool(mode, tool.readOnly)) {
      const msg =
        `Read mode blocks the mutating tool "${call.name}". ` +
        `Finish the plan, then switch with /mode ask (or /mode auto) before making changes.`;
      this.ui.onToolEnd(call, msg, true);
      return { result: msg };
    }

    // 3. Permission gate. auto mode auto-accepts what would otherwise ask.
    if (tool.permission === "deny") {
      const msg = `Tool "${call.name}" is disabled by policy. Use a different tool.`;
      this.ui.onToolEnd(call, msg, true);
      return { result: msg };
    }
    const needsAsk =
      tool.permission === "ask" && !this.alwaysAllowed.has(call.name) && !autoAccepts(mode);

    // Preview the proposed change (diff / command) — shown always, so the
    // user sees the edit whether or not we prompt (Claude Code/OpenCode put
    // the diff right in the approval; if always-allowed it still displays).
    if (tool.preview && this.ui.onToolPreview) {
      try {
        const preview = await tool.preview(validated.input, this.toolCtx);
        if (preview) this.ui.onToolPreview(call, preview);
      } catch {
        // preview is best-effort; never block execution on it
      }
    }

    if (needsAsk) {
      const decision = await this.ui.askPermission(call);
      if (decision === "no") {
        const msg =
          `The user declined this ${call.name} call. Do not retry the same call. ` +
          `Ask the user what they would like instead, or proceed differently.`;
        this.ui.onToolEnd(call, "declined by user", false);
        return { result: msg };
      }
      if (decision === "always") this.alwaysAllowed.add(call.name);
    }

    // 4. Execute.
    let result: string;
    let crashed = false;
    try {
      result = await tool.execute(validated.input, this.toolCtx);
    } catch (err) {
      crashed = true;
      result = `Tool "${call.name}" crashed: ${(err as Error).message}. This is a harness bug, not your mistake — try a different approach.`;
    }
    // Successful edits get deterministic compiler feedback before the model's
    // next request. Clean checks deliberately add nothing to the context.
    if (!crashed && /^(Applied:|Wrote )/.test(result) && this.toolCtx.postEditDiagnostics) {
      try {
        const diagnostics = await this.toolCtx.postEditDiagnostics();
        if (diagnostics) result += `\n\n[post-edit diagnostics]\n${diagnostics}`;
      } catch {
        // Diagnostics are a recovery aid, never a reason to fail an edit.
      }
    }
    if (verdict.action === "nudge") result += verdict.note;
    this.ui.onToolEnd(call, result, crashed);
    return { result };
  }
}
