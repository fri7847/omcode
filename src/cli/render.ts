// Presentation layer — OMcode's own identity (not a Claude Code reskin).
//
// Design intent: a no-nonsense workshop tool for wrangling slow, unreliable
// open models. So the UI (a) streams the model's text LIVE — you watch the
// answer form and can stop it, rather than staring at a token counter — and
// (b) surfaces the harness's own signals (recovered calls, fuzzy matches,
// interventions) which are OMcode's reason to exist.
//
// Visual language: teal accent + monochrome. User turn = `»`. Tool = `▸`.
// Result = `└`. Spinner = braille. Reasoning (<think>) streams dimmed.

import { stdout } from "node:process";
import { renderDiff } from "./diff.js";
import type { ToolPreview } from "../tools/registry.js";

// ---- palette: teal accent, white text, gray meta ----
const TEAL = "\x1b[38;2;45;212;191m"; // #2dd4bf — OMcode's accent
const R = "\x1b[0m";
const accent = (s: string) => `${TEAL}${s}${R}`;
const dim = (s: string) => `\x1b[38;2;120;120;128m${s}${R}`;
const bold = (s: string) => `\x1b[1m${s}${R}`;
const cyan = (s: string) => `\x1b[36m${s}${R}`;
const green = (s: string) => `\x1b[38;2;74;222;128m${s}${R}`;
const yellow = (s: string) => `\x1b[38;2;250;204;21m${s}${R}`;
const red = (s: string) => `\x1b[38;2;248;113;113m${s}${R}`;
const DIM_OPEN = "\x1b[38;2;120;120;128m";

export const style = { accent, dim, bold, cyan, green, yellow, red };

// braille spinner — deliberately NOT Claude Code's star pulse
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * Streams model text live, styling <think>…</think> reasoning as dim. Tag
 * detection buffers a small tail so a tag split across deltas still matches.
 * Reasoning is shown for transparency but is NOT what gets sent back to the
 * model (io-guard strips it from history) — this display is purely cosmetic.
 */
class ThinkFilter {
  private inThink = false;
  private buf = "";

  /** returns styled text to write for this chunk */
  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    for (;;) {
      if (!this.inThink) {
        const i = this.buf.indexOf("<think>");
        if (i === -1) {
          const safe = safeEmitLen(this.buf, "<think>");
          out += this.buf.slice(0, safe);
          this.buf = this.buf.slice(safe);
          break;
        }
        out += this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 7);
        this.inThink = true;
        out += DIM_OPEN;
      } else {
        const j = this.buf.indexOf("</think>");
        if (j === -1) {
          const safe = safeEmitLen(this.buf, "</think>");
          out += this.buf.slice(0, safe);
          this.buf = this.buf.slice(safe);
          break;
        }
        out += this.buf.slice(0, j) + R;
        this.buf = this.buf.slice(j + 8);
        this.inThink = false;
      }
    }
    return out;
  }

  reset(): void {
    if (this.inThink) stdout.write(R);
    this.inThink = false;
    this.buf = "";
  }
}

/** longest prefix of buf that cannot be the start of `tag` (safe to emit). */
function safeEmitLen(buf: string, tag: string): number {
  const maxHold = tag.length - 1;
  for (let hold = Math.min(maxHold, buf.length); hold > 0; hold--) {
    if (tag.startsWith(buf.slice(buf.length - hold))) return buf.length - hold;
  }
  return buf.length;
}

class Spinner {
  private timer?: ReturnType<typeof setInterval>;
  private startMs = 0;
  private frame = 0;
  private active = false;
  constructor(private tty: boolean) {}

  begin(): void {
    if (!this.tty || this.active) return;
    this.active = true;
    this.startMs = Date.now();
    this.frame = 0;
    this.timer = setInterval(() => this.draw(), 80);
    this.draw();
  }

  private draw(): void {
    const g = FRAMES[this.frame++ % FRAMES.length]!;
    stdout.write(`\r\x1b[K${accent(g)} ${dim(`working · ${fmtElapsed(Date.now() - this.startMs)} · esc`)}`);
  }

  end(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    if (this.tty) stdout.write("\r\x1b[K");
  }
}

interface Totals {
  requests: number;
  tools: number;
  prompt: number;
  completion: number;
  lastContext: number;
  added: number;
  removed: number;
}

export class Renderer {
  private spinner: Spinner;
  private tty: boolean;
  private think = new ThinkFilter();
  private streamedAny = false;
  private totals: Totals = {
    requests: 0, tools: 0, prompt: 0, completion: 0, lastContext: 0, added: 0, removed: 0,
  };

  /** fixed-screen mode routes the footer to the fixed status line */
  statusSink?: (line: string) => void;

  constructor(private numCtx: number) {
    this.tty = Boolean(stdout.isTTY);
    this.spinner = new Spinner(this.tty);
  }

  // ---- per-request lifecycle (drives spinner + stream state) ----
  thinkingStart(): void {
    this.think.reset();
    this.streamedAny = false;
    this.spinner.begin();
  }
  thinkingStop(): void {
    this.spinner.end();
  }

  /** live model text — the fundamental: show the answer forming, not a number */
  streamText(delta: string): void {
    const visible = this.think.push(delta);
    if (!visible) return;
    if (!this.streamedAny) {
      this.spinner.end();
      stdout.write("\n "); // blank line + a left margin to open the agent's turn
      this.streamedAny = true;
    }
    stdout.write(visible);
  }

  /** final buffered text — only print if nothing streamed (non-stream mode) */
  assistant(text: string): void {
    if (this.streamedAny) {
      stdout.write("\n");
      this.streamedAny = false;
      this.think.reset();
      return;
    }
    if (!text) return;
    stdout.write(`\n ${text}\n`);
  }

  fileChange(added: number, removed: number): void {
    this.totals.added += added;
    this.totals.removed += removed;
  }

  toolPreview(preview: ToolPreview): void {
    this.spinner.end();
    if (preview.kind === "command") {
      stdout.write(`${dim("   $")} ${preview.text}\n`);
      return;
    }
    stdout.write(renderDiff(preview.before, preview.after, { color: this.tty, indent: "   ", path: preview.path }) + "\n");
  }

  toolCall(name: string, args: Record<string, unknown>): void {
    this.spinner.end();
    stdout.write(`\n ${accent("▸")} ${bold(name)} ${dim(formatArgs(name, args))}\n`);
  }

  toolResult(result: string, isError: boolean): void {
    const s = summarize(result);
    stdout.write(dim("   └ ") + (isError ? yellow(s) : dim(s)) + "\n");
  }

  notice(msg: string): void {
    this.spinner.end();
    // harness signals (recovered / intervened / context) — OMcode's identity
    stdout.write(`   ${accent("◆")} ${dim(msg)}\n`);
  }

  error(msg: string): void {
    this.spinner.end();
    stdout.write(red(`\n   ✗ ${msg}\n`));
  }

  header(model: string, host: string, sessionFile: string, stream: boolean): void {
    const hostShort = host.replace(/^https?:\/\//, "");
    stdout.write(`\n ${accent("▍")}${bold("omcode")} ${dim("· open-model coding agent")}\n`);
    stdout.write(dim(`  ${model}  ${hostShort}  ${Math.round(this.numCtx / 1000)}K ctx  stream:${stream ? "on" : "off"}\n`));
    stdout.write(dim(`  ${sessionFile}\n`));
    stdout.write(dim(`  /model  /undo  /help  /exit   ·   \\ + enter = 여러 줄\n`));
  }

  help(): void {
    const cmd = (name: string, desc: string) => `  ${accent(name.padEnd(13))}${desc}\n`;
    stdout.write(
      "\n" +
        `  ${bold("commands")}\n` +
        cmd("/init", "이 저장소를 분석해 AGENTS.md 생성") +
        cmd("/model", "서버의 모델 목록에서 전환 (선택 저장)") +
        cmd("/mode", "architect(읽기전용) / editor 전환") +
        cmd("/think", "추론(thinking) 모드 세션 토글 [on|off]") +
        cmd("/compact", "오래된 대화를 요약해 컨텍스트 확보") +
        cmd("/clear", "대화 초기화 (모델·모드 유지)") +
        cmd("/cost", "이번 세션 토큰·컨텍스트 사용량") +
        cmd("/diff", "이번 세션에 바뀐 파일 전체 diff") +
        cmd("/lint", "프로젝트 언어 검사기 실행 (tsc/go vet/ruff)") +
        cmd("/test", "프로젝트 테스트 명령 실행") +
        cmd("/new", "새 세션 파일로 완전히 새 대화 시작") +
        cmd("/status", "현재 모델·호스트·모드·컨텍스트 상태") +
        cmd("/doctor", "설정 점검 (호스트 연결·모델·VRAM)") +
        cmd("/config", "설정 보기 / `/config <키> <값>`으로 저장") +
        cmd("/permissions", "도구 권한 보기 / allow·ask 세션 재정의") +
        cmd("/mcp", "연결된 MCP 서버·도구 상태") +
        cmd("/agents", "서브에이전트 목록 / `/agents new <이름>` 생성") +
        cmd("/undo", "마지막 턴이 바꾼 파일 되돌리기") +
        cmd("/help", "이 도움말") +
        cmd("/exit", "종료") +
        `  ${dim("입력 끝에 \\ + Enter = 다음 줄 이어쓰기 · 생성 중 esc = 중단")}\n\n`,
    );
  }

  /** Live context-window size (prompt tokens of the last request), for /status. */
  contextTokens(): number {
    return this.totals.lastContext;
  }

  /** /cost — cumulative session usage from the running totals. */
  cost(): void {
    const t = this.totals;
    const total = t.prompt + t.completion;
    const pct = this.numCtx > 0 ? Math.round((t.lastContext / this.numCtx) * 100) : 0;
    stdout.write(
      "\n" +
        `  ${bold("session usage")}\n` +
        `  tokens    ${fmtTokens(total)}  ${dim(`(${fmtTokens(t.prompt)}↑ prompt · ${fmtTokens(t.completion)}↓ completion)`)}\n` +
        `  requests  ${t.requests}  ${dim("·")}  tools ${t.tools}\n` +
        `  context   ${fmtTokens(t.lastContext)} / ${fmtTokens(this.numCtx)}  ${dim(`(${pct}%)`)}\n` +
        (t.added || t.removed ? `  code      ${green(`+${t.added}`)} ${red(`−${t.removed}`)}\n` : "") +
        "\n",
    );
  }

  turnFooter(turn: {
    requests: number; tools: number; prompt: number; completion: number;
    lastContext: number; recovered: number; edits?: { applied: number; attempts: number };
  }): void {
    this.totals.requests += turn.requests;
    this.totals.tools += turn.tools;
    this.totals.prompt += turn.prompt;
    this.totals.completion += turn.completion;
    if (turn.lastContext > 0) this.totals.lastContext = turn.lastContext;

    const pct = this.numCtx > 0 ? Math.round((this.totals.lastContext / this.numCtx) * 100) : 0;
    const parts = [`${turn.requests} req`, `${turn.tools} tool${turn.tools === 1 ? "" : "s"}`];
    if (turn.recovered) parts.push(`recovered ${turn.recovered}`);
    if (turn.edits && turn.edits.attempts > 0) parts.push(`edits ${turn.edits.applied}/${turn.edits.attempts}`);
    parts.push(`${fmtTokens(turn.prompt)}↑ ${fmtTokens(turn.completion)}↓`);

    const changes =
      this.totals.added || this.totals.removed
        ? ` · ${green(`+${this.totals.added}`)} ${red(`−${this.totals.removed}`)}`
        : "";
    const gauge = contextGauge(this.totals.lastContext, this.numCtx, pct);
    const sessionTok = fmtTokens(this.totals.prompt + this.totals.completion);
    if (this.statusSink) {
      this.statusSink(dim(`${gauge} · session ${sessionTok}${changes} · ${parts.join(" · ")}`));
      return;
    }
    stdout.write(dim(`\n   ${parts.join(" · ")}\n`));
    stdout.write(dim(`   ${gauge} · session ${sessionTok}`) + changes + "\n");
  }
}

// ---- helpers ----

function formatArgs(name: string, args: Record<string, unknown>): string {
  const primary =
    name === "shell"
      ? String(args["command"] ?? "")
      : typeof args["path"] === "string"
        ? String(args["path"])
        : typeof args["pattern"] === "string"
          ? String(args["pattern"])
          : JSON.stringify(args);
  return primary.length > 72 ? primary.slice(0, 69) + "…" : primary;
}

function summarize(result: string): string {
  const trimmed = result.trim();
  if (!trimmed) return "(empty)";
  const lines = trimmed.split("\n");
  const first = lines[0]!.replace(/\t/g, " ").trim();
  const head = first.length > 76 ? first.slice(0, 73) + "…" : first;
  return lines.length > 1 ? `${head} (+${lines.length - 1})` : head;
}

function contextGauge(used: number, total: number, pct: number): string {
  const width = 12;
  const filled = Math.min(width, Math.round((used / Math.max(total, 1)) * width));
  const bar = "▰".repeat(filled) + "▱".repeat(width - filled);
  const color = pct >= 85 ? red : pct >= 60 ? yellow : green;
  return `${color(bar)} ${pct}%`;
}
