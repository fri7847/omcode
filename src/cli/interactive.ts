// Fixed-screen interactive session. Header/status/input stay fixed; only the
// output region scrolls (see screen.ts). One raw-stdin dispatcher routes keys
// to the line editor (prompt / number entry) or the running turn (esc abort),
// so nothing fights over stdin. Selections are INLINE number entry printed in
// the output region — no takeover "selection screen", and previous output
// stays visible. TTY only; repl.ts keeps the plain inline path for pipes.

import { stdin, stdout } from "node:process";
import { FixedScreen, decodeKeys, type Key } from "./screen.js";
import { style } from "./render.js";
import type { Renderer } from "./render.js";
import type { AgentLoop, LoopUI, PermissionDecision } from "../core/loop.js";
import type { ToolCall } from "../model/provider.js";
import { parseAgentMode, type AgentMode } from "../core/agent-mode.js";
import {
  INIT_PROMPT, clearConversation, compactNow, sessionDiff, lintProject, testProject,
  statusText, doctorText, configText, setConfig, permissions, toggleThink, mcpStatusText, agentsText, newAgentScaffold, type EnvInfo,
} from "./commands.js";
import type { McpServerStatus } from "../tools/mcp.js";
import { matchSlash, commonPrefix } from "./slash.js";

const { accent, dim } = style;

export interface MenuItem {
  label: string;
  hint?: string;
}

type Mode = "idle" | "edit" | "turn";

class Dispatcher {
  private handler: ((k: Key) => void) | null = null;
  constructor() {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", (buf: Buffer) => {
      const h = this.handler;
      if (!h) return;
      for (const k of decodeKeys(buf.toString("utf8"))) h(k);
    });
  }
  focus(_mode: Mode, handler: ((k: Key) => void) | null): void {
    this.handler = handler;
  }
  stop(): void {
    this.handler = null;
    try {
      stdin.setRawMode(false);
    } catch {
      /* stdin already closed */
    }
  }
}

interface EditOpts {
  history?: string[];
  escCancels?: boolean;
}

/** Line editor bound to the fixed input row. Resolves the typed line, or null
 * on Ctrl+C (always) / Esc (when escCancels). */
function editLine(screen: FixedScreen, disp: Dispatcher, opts: EditOpts = {}): Promise<string | null> {
  const history = opts.history ?? [];
  return new Promise((resolve) => {
    let buf = "";
    let cur = 0;
    let hIdx = history.length;
    screen.showCursor();

    // Slash autocomplete: while typing a bare "/cmd" token, show the matching
    // commands on the strip above the input and preview the best match as ghost
    // text. Tab completes. Nothing renders for ordinary input.
    const redraw = (): void => {
      const names = matchSlash(buf).map((m) => m.name);
      const ghost = names[0] && names[0].length > buf.length ? names[0].slice(buf.length) : "";
      screen.drawInput(buf, cur, ghost);
      screen.drawSuggestions(names.slice(0, 8));
    };
    redraw();

    disp.focus("edit", (k) => {
      switch (k.t) {
        case "char":
          buf = buf.slice(0, cur) + k.s + buf.slice(cur);
          cur += k.s.length;
          break;
        case "tab": {
          const m = matchSlash(buf).map((x) => x.name);
          if (m.length === 1) { buf = m[0]! + " "; cur = buf.length; }
          else if (m.length > 1) {
            const cp = commonPrefix(m);
            if (cp.length > buf.length) { buf = cp; cur = buf.length; }
          }
          break;
        }
        case "backspace":
          if (cur > 0) { buf = buf.slice(0, cur - 1) + buf.slice(cur); cur--; }
          break;
        case "left": if (cur > 0) cur--; break;
        case "right": if (cur < buf.length) cur++; break;
        case "home": cur = 0; break;
        case "end": cur = buf.length; break;
        case "up":
          if (hIdx > 0) { hIdx--; buf = history[hIdx] ?? ""; cur = buf.length; }
          break;
        case "down":
          if (hIdx < history.length) { hIdx++; buf = history[hIdx] ?? ""; cur = buf.length; }
          break;
        case "enter":
          if (buf.endsWith("\\")) { buf = buf.slice(0, -1) + "\n"; cur = buf.length; break; }
          screen.drawSuggestions([]);
          screen.hideCursor();
          disp.focus("idle", null);
          resolve(buf);
          return;
        case "ctrlc":
          screen.drawSuggestions([]);
          screen.hideCursor();
          disp.focus("idle", null);
          resolve(null);
          return;
        case "esc":
          if (opts.escCancels) {
            screen.drawSuggestions([]);
            screen.hideCursor();
            disp.focus("idle", null);
            resolve(null);
            return;
          }
          buf = "";
          cur = 0;
          break;
      }
      redraw();
    });
  });
}

/** Arrow-key selection, drawn inline in the scrolling output region — no screen
 * swap, previous output stays visible. ↑↓/j k move, Enter picks, Esc cancels. */
function menu(
  screen: FixedScreen,
  disp: Dispatcher,
  title: string,
  items: MenuItem[],
  start = 0,
): Promise<number | null> {
  return new Promise((resolve) => {
    let sel = Math.min(Math.max(start, 0), items.length - 1);
    screen.hideCursor();
    stdout.write("  " + title + "\n"); // title (1 line) + N item lines
    draw(true);

    function draw(first: boolean): void {
      if (!first) stdout.write(`\x1b[${items.length}A`);
      items.forEach((it, i) => {
        const on = i === sel;
        const pointer = on ? `${accent("❯")} ` : "  ";
        const label = on ? accent(it.label) : it.label;
        const hint = it.hint ? ` ${dim(it.hint)}` : "";
        stdout.write(`\x1b[2K    ${pointer}${label}${hint}\n`);
      });
    }
    function move(d: number): void {
      const n = (sel + d + items.length) % items.length;
      if (n !== sel) { sel = n; draw(false); }
    }
    /** erase the whole menu (title + items) so it doesn't linger in the chat —
     * leaves the cursor where the menu started so a compact result can replace it. */
    function erase(): void {
      stdout.write("\r");
      for (let i = 0; i < items.length + 1; i++) stdout.write("\x1b[1A\x1b[2K");
    }
    disp.focus("edit", (k) => {
      if (k.t === "up") move(-1);
      else if (k.t === "down") move(1);
      else if (k.t === "enter") { erase(); disp.focus("idle", null); resolve(sel); }
      else if (k.t === "esc" || k.t === "ctrlc") { erase(); disp.focus("idle", null); resolve(null); }
    });
  });
}

export interface FixedDeps {
  screen: FixedScreen;
  render: Renderer;
  makeLoop: (ui: LoopUI) => AgentLoop;
  editStats: { applied: number; attempts: number };
  checkpoints: {
    beginTurn(): void;
    undoLastTurn(): Promise<string[]>;
    originals(): { path: string; before: string | null }[];
  };
  cwd: string;
  /** static parts of the status/doctor view — model/mode/sessionFile are live */
  env: Omit<EnvInfo, "model" | "mode" | "sessionFile">;
  sessionFile: string;
  detectVram: () => Promise<number | undefined>;
  newSessionLog: () => { append(type: string, data?: Record<string, unknown>): void; file: string };
  mcpStatus: () => McpServerStatus[];
  currentThink: () => boolean | undefined;
  listModels: () => Promise<string[]>;
  onModelPick: (model: string) => void;
  currentModel: () => string;
  onModePick: (mode: AgentMode) => void;
  currentMode: () => AgentMode;
  headerLine: () => string;
}

export async function runFixed(deps: FixedDeps): Promise<void> {
  const { screen, render } = deps;
  const disp = new Dispatcher();
  const history: string[] = [];

  screen.start();
  screen.setHeader(deps.headerLine());
  render.statusSink = (line) => screen.setStatus(line);

  const ui: LoopUI = {
    onAssistantDelta: (t) => render.streamText(t),
    onThinkingStart: () => render.thinkingStart(),
    onThinkingStop: () => render.thinkingStop(),
    onAssistantText: (t) => render.assistant(t),
    onToolStart: (c) => render.toolCall(c.name, c.arguments),
    onToolPreview: (_c, p) => render.toolPreview(p),
    onToolEnd: (_c, r, isErr) => render.toolResult(r, isErr),
    onNotice: (m) => render.notice(m),
    askPermission: async (call: ToolCall): Promise<PermissionDecision> => {
      const items: MenuItem[] = [
        { label: "예, 이번만" },
        { label: `예, 이 세션 동안 ${call.name} 항상 허용` },
        { label: "아니오" },
      ];
      const chosen = await menu(screen, disp, style.yellow(`${call.name} 실행을 허용할까요?`), items);
      return chosen === 1 ? "always" : chosen === 0 ? "yes" : "no";
    },
  };

  const loop = deps.makeLoop(ui);
  let sessionFile = deps.sessionFile;
  const envInfo = (): EnvInfo => ({
    ...deps.env,
    model: deps.currentModel(),
    mode: deps.currentMode(),
    think: deps.currentThink(),
    sessionFile,
  });

  for (;;) {
    screen.saveCursor();
    const raw = await editLine(screen, disp, { history });
    screen.restoreCursor();
    if (raw === null) break;
    const input = raw.trim();
    if (!input) continue;
    history.push(input);

    // Slash commands leave no `» command` echo — only their result stays in the
    // chat (the transient command UI is erased), so the conversation stays clean.
    if (input === "/exit" || input === "/quit") break;
    if (input === "/help") { render.help(); continue; }
    if (input === "/clear") { render.notice(clearConversation(loop)); continue; }
    if (input === "/compact") { render.notice(await compactNow(loop)); continue; }
    if (input === "/cost") { render.cost(); continue; }
    if (input === "/diff") { stdout.write("\n" + (await sessionDiff(deps.checkpoints, deps.cwd, true)) + "\n"); continue; }
    if (input === "/lint") { render.notice("linting…"); stdout.write("\n" + (await lintProject(deps.cwd)) + "\n"); continue; }
    if (input === "/test") { render.notice("running tests…"); stdout.write("\n" + (await testProject(deps.cwd)) + "\n"); continue; }
    if (input === "/status") { stdout.write("\n" + statusText(envInfo(), render.contextTokens()) + "\n"); continue; }
    if (input === "/doctor") { render.notice("checking…"); stdout.write("\n" + (await doctorText(envInfo(), deps.listModels, deps.detectVram)) + "\n"); continue; }
    if (input.startsWith("/config")) {
      const [, key, ...rest] = input.split(/\s+/);
      stdout.write("\n" + (key ? setConfig(key, rest.join(" ")) : configText()) + "\n");
      continue;
    }
    if (input.startsWith("/permissions")) { stdout.write("\n" + permissions(loop, input.split(/\s+/).slice(1)) + "\n"); continue; }
    if (input.startsWith("/think")) { render.notice(toggleThink(loop, input.split(/\s+/)[1])); continue; }
    if (input === "/mcp") { stdout.write("\n" + mcpStatusText(deps.mcpStatus()) + "\n"); continue; }
    if (input.startsWith("/agents")) {
      const [, sub, name] = input.split(/\s+/);
      stdout.write("\n" + (sub === "new" ? newAgentScaffold(deps.cwd, name ?? "") : agentsText(deps.cwd)) + "\n");
      continue;
    }
    if (input === "/new") { const s = deps.newSessionLog(); loop.newSession(s); sessionFile = s.file; render.notice("new session → " + s.file); continue; }
    if (input === "/undo") {
      const restored = await deps.checkpoints.undoLastTurn();
      render.notice(restored.length ? `restored: ${restored.map((p) => p.split(/[\\/]/).pop()).join(", ")}` : "되돌릴 변경 없음");
      continue;
    }
    if (input === "/model") {
      const models = await deps.listModels();
      if (models.length === 0) { render.notice("모델 목록을 가져올 수 없음"); continue; }
      const items: MenuItem[] = models.map((m) => ({ label: m, hint: m === deps.currentModel() ? "현재" : undefined }));
      const chosen = await menu(screen, disp, accent("모델 선택"), items, Math.max(0, models.indexOf(deps.currentModel())));
      if (chosen !== null) {
        deps.onModelPick(models[chosen]!);
        screen.setHeader(deps.headerLine());
        render.notice(`model → ${models[chosen]}`);
      }
      continue;
    }
    if (input.startsWith("/mode")) {
      const mode = parseAgentMode(input.split(/\s+/, 2)[1]);
      if (!mode) { render.notice("usage: /mode scout | check | flow"); continue; }
      loop.setMode(mode);
      deps.onModePick(mode);
      screen.setHeader(deps.headerLine());
      render.notice(`mode → ${mode}`);
      continue;
    }

    // /init runs the canned analysis prompt as a normal turn (reuses the whole
    // agent loop + write-with-approval); the echo still shows the short command.
    const turnInput = input === "/init" ? INIT_PROMPT : input;

    // real chat input — echoed as the user's turn, then run
    stdout.write("\n " + accent("»") + " " + input.replace(/\n/g, dim(" ⏎ ")) + "\n");

    // ---- run a turn (esc aborts) ----
    deps.checkpoints.beginTurn();
    const editsBefore = deps.editStats.applied;
    const attemptsBefore = deps.editStats.attempts;
    const ac = new AbortController();
    disp.focus("turn", (k) => {
      if (k.t === "esc" || k.t === "ctrlc") ac.abort();
    });
    try {
      const stats = await loop.runTurn(turnInput, ac.signal);
      render.turnFooter({
        requests: stats.requests,
        tools: stats.toolCalls,
        prompt: stats.promptTokens,
        completion: stats.completionTokens,
        lastContext: stats.lastPromptTokens,
        recovered: stats.recoveredCalls,
        edits: { applied: deps.editStats.applied - editsBefore, attempts: deps.editStats.attempts - attemptsBefore },
      });
    } catch (err) {
      render.error((err as Error).message);
    } finally {
      disp.focus("idle", null);
    }
  }

  render.statusSink = undefined;
  disp.stop();
  screen.stop();
}
