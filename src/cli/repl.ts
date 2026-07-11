// Minimal REPL frontend. The core emits through the LoopUI interface, so this
// file can later be replaced by an Ink TUI or a server without touching core.
//
// Usage:  tsx src/cli/repl.ts [--resume [session.jsonl]]
// Env:    OMCODE_HOST, OMCODE_MODEL, OMCODE_NUM_CTX, OMCODE_THINK,
//         OMCODE_STREAM (default on), OMCODE_CONDENSE_MODEL, OLLAMA_API_KEY

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AgentLoop, type LoopUI, type PermissionDecision } from "../core/loop.js";
import { SessionLog, latestSessionFile, loadMessages, listSessions } from "../core/session.js";
import { ContextManager, condensePrompt } from "../core/context.js";
import { CheckpointStore } from "../core/checkpoint.js";
import { OllamaProvider } from "../model/ollama.js";
import type { ChatMessage, ToolCall } from "../model/provider.js";
import { buildSystemPrompt } from "../prompt/system.js";
import { profileFor } from "../model/profiles.js";
import { ToolRegistry } from "../tools/registry.js";
import { readTool } from "../tools/read.js";
import { globTool } from "../tools/glob.js";
import { grepTool } from "../tools/grep.js";
import { repoMapTool } from "../tools/repo-map.js";
import { typecheckFailure, typecheckTool } from "../tools/typecheck.js";
import { makeTaskTool } from "../tools/task.js";
import { makeEditTool, newEditStats } from "../tools/edit.js";
import { writeTool } from "../tools/write.js";
import { detectShell, makeShellTool } from "../tools/shell.js";
import { resolveSettings, saveConfig, configFile } from "./config.js";
import { Renderer, style } from "./render.js";
import { FixedScreen } from "./screen.js";
import { runFixed } from "./interactive.js";
import { parseAgentMode } from "../core/agent-mode.js";
import { contextWindowWarning, detectNvidiaVramMiB } from "../model/runtime.js";

interface MenuItem {
  label: string;
  hint?: string;
}

const settings = resolveSettings();
const HOST = settings.host;
const API_KEY = settings.apiKey;
const NUM_CTX = settings.numCtx;
const THINK = settings.think;
const STREAM = settings.stream;

const { dim, cyan, yellow, accent, bold } = style;

export type Ask = (prompt: string) => Promise<string | null>;

/**
 * Input wrapper around readline that (a) buffers lines arriving before a
 * question is pending — piped stdin delivers everything at startup while we
 * are still fetching the model list — and (b) survives EOF (null = closed).
 */
function makeAsk(rl: readline.Interface): Ask {
  const pending: string[] = [];
  let closed = false;
  rl.on("line", (l) => pending.push(l)); // fires only when no question is active
  rl.once("close", () => {
    closed = true;
  });
  return async (prompt) => {
    const buffered = pending.shift();
    if (buffered !== undefined) {
      stdout.write(prompt + buffered + "\n");
      return buffered;
    }
    if (closed) return null;
    try {
      return await rl.question(prompt);
    } catch {
      return null;
    }
  };
}

/**
 * --resume            → latest session
 * --resume list       → interactive picker (recent 10, first-message preview)
 * --resume 3          → 3rd most recent
 * --resume <path>     → exact file
 */
async function resolveResume(
  pick: (title: string, items: MenuItem[]) => Promise<number | null>,
): Promise<ChatMessage[] | undefined> {
  const idx = process.argv.indexOf("--resume");
  if (idx < 0) return undefined;
  const arg = process.argv[idx + 1];

  let file: string | undefined;
  if (arg?.endsWith(".jsonl")) {
    file = arg;
  } else if (arg && /^\d+$/.test(arg)) {
    file = listSessions(Number(arg))[Number(arg) - 1]?.file;
  } else if (arg === "list") {
    const sessions = listSessions(10);
    if (sessions.length === 0) {
      stdout.write(yellow("  ‼ 이전 세션이 없습니다\n"));
      return undefined;
    }
    const items: MenuItem[] = sessions.map((s) => ({
      label: `${s.startedAt}  "${s.firstUser.replace(/\s+/g, " ").slice(0, 56)}"`,
      hint: `${s.messages} msgs`,
    }));
    const chosen = await pick(cyan("세션 선택"), items);
    if (chosen === null) {
      stdout.write(dim("  새 세션으로 시작합니다.\n\n"));
      return undefined;
    }
    file = sessions[chosen]!.file;
  } else {
    file = latestSessionFile();
  }

  if (!file) {
    stdout.write(yellow("  ‼ 이어갈 세션을 찾지 못했습니다\n"));
    return undefined;
  }
  try {
    const messages = loadMessages(file);
    stdout.write(dim(`  ↺ resumed ${messages.length} messages\n\n`));
    return messages;
  } catch (err) {
    stdout.write(yellow(`  ‼ resume 실패: ${(err as Error).message}\n`));
    return undefined;
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = makeAsk(rl);

  const provider = new OllamaProvider({ host: HOST, apiKey: API_KEY });
  const registry = new ToolRegistry();
  const shell = detectShell();
  const editStats = newEditStats();
  registry.register(readTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(repoMapTool);
  registry.register(typecheckTool);
  registry.register(makeEditTool(editStats));
  registry.register(writeTool);
  registry.register(makeShellTool(shell));

  const checkpoints = new CheckpointStore();
  const render = new Renderer(NUM_CTX);

  // Model profile: family-specific think default + system-prompt addendum.
  // The user's explicit think (env/config) always wins over the profile default.
  const profile = profileFor(settings.model);
  const loopConfig = {
    model: settings.model,
    numCtx: NUM_CTX,
    maxToolCallsPerTurn: 25,
    think: THINK ?? profile.think,
    mode: settings.mode,
  };

  // Only probe local Ollama. Cloud hosts do not use this machine's VRAM.
  if (/localhost|127\.0\.0\.1|\[::1\]/.test(HOST)) {
    const vramMiB = await detectNvidiaVramMiB();
    const warning = vramMiB ? contextWindowWarning(loopConfig.model, NUM_CTX, vramMiB) : undefined;
    if (warning) stdout.write(yellow(`  ‼ ${warning}\n`));
  }

  const contextMgr = new ContextManager(
    { numCtx: NUM_CTX, reserve: 4096, keepRecent: 8 },
    async (transcript) => {
      const res = await provider.chat({
        // Optional small-model condenser follows Crush's split-model pattern:
        // it lowers the cost of compression without changing the main agent.
        // Falling back to the active model preserves existing configurations.
        model: settings.condenseModel ?? loopConfig.model,
        messages: [{ role: "user", content: condensePrompt(transcript) }],
        tools: [],
        numCtx: NUM_CTX,
        think: false,
      });
      return res.content;
    },
  );

  /** interactive model picker — lists what the host actually serves, saves choice */
  async function pickModel(available: string[]): Promise<void> {
    if (available.length === 0) {
      stdout.write(yellow(`  ‼ 모델 목록을 가져올 수 없습니다 (${HOST}). 호스트/키를 확인하세요.\n`));
      return;
    }
    const items: MenuItem[] = available.map((m) => ({
      label: m,
      hint: m === loopConfig.model ? "현재" : undefined,
    }));
    const chosen = await pick(cyan("모델 선택"), items);
    if (chosen === null) return;
    loopConfig.model = available[chosen]!;
    if (THINK === undefined) loopConfig.think = profileFor(loopConfig.model).think;
    saveConfig({ model: loopConfig.model, host: HOST });
    stdout.write(dim(`\n  model → ${cyan(loopConfig.model)} (saved)\n`));
  }

  /** Plain inline numbered prompt — flows in normal scrollback, no takeover
   * screen (previous content and the conversation stay visible / scroll up). */
  async function pick(title: string, items: MenuItem[]): Promise<number | null> {
    stdout.write("\n  " + title + "\n");
    items.forEach((it, i) => {
      const mark = it.hint ? dim(` — ${it.hint}`) : "";
      stdout.write(`    ${accent(String(i + 1))}. ${it.label}${mark}\n`);
    });
    const answer = ((await ask(dim("\n  번호 (Enter=취소): "))) ?? "").trim();
    const n = Number(answer);
    if (!answer || !Number.isInteger(n) || n < 1 || n > items.length) return null;
    return n - 1;
  }

  // Startup validation: never let the first turn die on a 404 (bad default UX).
  const available = await provider.listModels();
  if (available.length > 0 && !available.includes(loopConfig.model)) {
    stdout.write(yellow(`  ‼ "${loopConfig.model}" 모델이 ${HOST} 에 없습니다.\n`));
    await pickModel(available);
  }

  const session = new SessionLog();
  const cwd = process.cwd();
  const resumeMessages = await resolveResume(pick);
  const systemPrompt = buildSystemPrompt(cwd, shell.label, settings.mode, profile.systemAddendum);

  const toolCtx = {
    cwd,
    checkpoints,
    onFileChange: (a: number, r: number) => render.fileChange(a, r),
    postEditDiagnostics: () => typecheckFailure(cwd),
  };

  // Subtasks share the provider but get a fresh message list and a read-only
  // registry. Only this short final report returns to the parent turn.
  registry.register(makeTaskTool(async (description, maxToolCalls) => {
    const scoutRegistry = new ToolRegistry();
    scoutRegistry.register(readTool);
    scoutRegistry.register(globTool);
    scoutRegistry.register(grepTool);
    scoutRegistry.register(repoMapTool);
    let report = "";
    const notices: string[] = [];
    const scout = new AgentLoop(
      provider,
      scoutRegistry,
      { model: loopConfig.model, numCtx: NUM_CTX, maxToolCallsPerTurn: maxToolCalls, think: THINK, mode: "architect" },
      {
        onAssistantText: (text) => { report = text; },
        onToolStart() {}, onToolEnd() {},
        onNotice: (notice) => notices.push(notice),
        askPermission: async () => "no",
      },
      { append() {} },
      { cwd },
      buildSystemPrompt(cwd, shell.label, "architect"),
    );
    const stats = await scout.runTurn(
      `Investigate this focused subtask using read-only tools. Return concise, actionable facts with exact file paths and symbols. Do not propose edits you did not verify.\n\n${description}`,
    );
    const suffix = notices.length ? `\nHarness notes: ${notices.join("; ")}` : "";
    return `Isolated subtask report (${stats.toolCalls} tool calls):\n${report || "No final report was produced."}${suffix}`;
  }));

  const makeLoop = (ui: LoopUI): AgentLoop =>
    new AgentLoop(
      provider,
      registry,
      loopConfig,
      ui,
      session,
      toolCtx,
      systemPrompt,
      contextMgr,
      resumeMessages,
    );

  // ---- fixed-chrome layout (real terminal) vs plain inline (pipes/non-TTY) ----
  if (Boolean(stdout.isTTY) && Boolean(stdin.isTTY)) {
    rl.close(); // the fixed screen owns stdin directly
    if (HOST.includes("ollama.com") && !API_KEY) {
      stdout.write(yellow(`   ‼ API 키가 없습니다 (${configFile()}).\n`));
    }
    await runFixed({
      screen: new FixedScreen(),
      render,
      makeLoop,
      editStats,
      checkpoints,
      listModels: () => provider.listModels(),
      onModelPick: (m) => {
        loopConfig.model = m;
        if (THINK === undefined) loopConfig.think = profileFor(m).think;
        saveConfig({ model: m, host: HOST });
      },
      currentModel: () => loopConfig.model,
      onModePick: (mode) => { loopConfig.mode = mode; },
      currentMode: () => loopConfig.mode,
      headerLine: () =>
        `${accent("▍")}${bold("omcode")} ${dim(`· ${loopConfig.mode} · ${loopConfig.model} · ${HOST.replace(/^https?:\/\//, "")} · ${Math.round(NUM_CTX / 1000)}K · /help`)}`,
    });
    return;
  }

  // ---- plain inline path (pipes / non-TTY) ----
  const ui: LoopUI = {
    onAssistantDelta: STREAM ? (t) => render.streamText(t) : undefined,
    onThinkingStart: () => render.thinkingStart(),
    onThinkingStop: () => render.thinkingStop(),
    onAssistantText: (text) => render.assistant(text),
    onToolStart: (call) => render.toolCall(call.name, call.arguments),
    onToolPreview: (_call, preview) => render.toolPreview(preview),
    onToolEnd: (_call, result, isError) => render.toolResult(result, isError),
    onNotice: (msg) => render.notice(msg),
    askPermission: async (call: ToolCall): Promise<PermissionDecision> => {
      const items: MenuItem[] = [
        { label: "예, 이번만" },
        { label: `예, 이 세션 동안 ${call.name} 항상 허용` },
        { label: "아니오" },
      ];
      const chosen = await pick(yellow(`${call.name} 실행을 허용할까요?`), items);
      return chosen === 1 ? "always" : chosen === 0 ? "yes" : "no";
    },
  };
  const loop = makeLoop(ui);

  render.header(loopConfig.model, HOST, session.file, STREAM);
  if (HOST.includes("ollama.com") && !API_KEY) {
    stdout.write(yellow(`   ‼ API 키가 없습니다. Ollama Cloud에는 키가 필요합니다 (${configFile()}).\n\n`));
  }

  while (true) {
    // `»` marks the user turn (OMcode's prompt). A line ending in `\` continues
    // onto the next line so code blocks / multi-line instructions can be pasted.
    let raw = await ask(`\n ${accent("»")} `);
    if (raw === null) break; // stdin closed (EOF / Ctrl+D)
    while (raw !== null && raw.endsWith("\\")) {
      const more = await ask(dim("   … "));
      if (more === null) break;
      raw = raw.slice(0, -1) + "\n" + more;
    }
    if (raw === null) break;
    const input = raw.trim();
    if (!input) continue;
    if (input === "/exit" || input === "/quit") break;
    if (input === "/help") {
      render.help();
      continue;
    }
    if (input === "/model") {
      await pickModel(await provider.listModels());
      continue;
    }
    if (input.startsWith("/mode")) {
      const mode = parseAgentMode(input.split(/\s+/, 2)[1]);
      if (!mode) {
        stdout.write(yellow("  ‼ 사용법: /mode architect 또는 /mode editor\n"));
        continue;
      }
      loop.setMode(mode);
      loopConfig.mode = mode;
      stdout.write(dim(`  mode → ${cyan(mode)}\n`));
      continue;
    }
    if (input === "/undo") {
      const restored = await checkpoints.undoLastTurn();
      stdout.write(
        restored.length
          ? dim(`  ↩ restored: ${restored.map((p) => p.split(/[\\/]/).pop()).join(", ")}\n\n`)
          : yellow(`  ‼ 되돌릴 변경이 없습니다\n\n`),
      );
      continue;
    }

    checkpoints.beginTurn();
    const editsBefore = editStats.applied;
    const attemptsBefore = editStats.attempts;

    // esc-to-interrupt: while the turn runs, watch stdin for a lone ESC (or
    // Ctrl+C) and abort the in-flight request. Pause readline so its own key
    // handling doesn't fight ours.
    const ac = new AbortController();
    const tty = Boolean(stdin.isTTY);
    const onKey = (buf: Buffer) => {
      const s = buf.toString("utf8");
      if (s === "\x1b" || s.includes("\x03")) ac.abort();
    };
    if (tty) {
      rl.pause();
      stdin.setRawMode(true);
      stdin.on("data", onKey);
    }

    try {
      const stats = await loop.runTurn(input, ac.signal);
      render.turnFooter({
        requests: stats.requests,
        tools: stats.toolCalls,
        prompt: stats.promptTokens,
        completion: stats.completionTokens,
        lastContext: stats.lastPromptTokens,
        recovered: stats.recoveredCalls,
        edits: {
          applied: editStats.applied - editsBefore,
          attempts: editStats.attempts - attemptsBefore,
        },
      });
    } catch (err) {
      render.error((err as Error).message);
    } finally {
      if (tty) {
        stdin.off("data", onKey);
        stdin.setRawMode(false);
        rl.resume();
      }
    }
  }
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
