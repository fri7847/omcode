// Slash-command autocomplete data + matching. Pure and UI-agnostic so the
// fixed-screen editor can render suggestions and the logic stays testable.
// Completes both the command name and its first argument.

export interface SlashCommand {
  name: string;
  desc: string;
  /** first-argument completions (e.g. /mode → read|ask|auto) */
  args?: string[];
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/init", desc: "저장소 분석해 AGENTS.md 생성" },
  { name: "/model", desc: "모델 전환" },
  { name: "/mode", desc: "read·ask·auto 전환", args: ["read", "ask", "auto"] },
  { name: "/think", desc: "추론 강도", args: ["off", "low", "medium", "high", "xhigh"] },
  { name: "/compact", desc: "컨텍스트 압축" },
  { name: "/clear", desc: "대화 초기화" },
  { name: "/new", desc: "새 세션 시작" },
  { name: "/cost", desc: "토큰 사용량" },
  { name: "/diff", desc: "세션 변경 diff" },
  { name: "/lint", desc: "언어 검사기 실행" },
  { name: "/test", desc: "테스트 실행" },
  { name: "/status", desc: "현재 상태" },
  { name: "/doctor", desc: "설정 점검" },
  { name: "/config", desc: "설정 보기/저장", args: ["host", "model", "numCtx", "stream", "think", "condenseModel", "mode", "maxOutput"] },
  { name: "/permissions", desc: "도구 권한", args: ["allow", "ask"] },
  { name: "/mcp", desc: "MCP 서버 상태" },
  { name: "/agents", desc: "서브에이전트", args: ["new"] },
  { name: "/verify", desc: "여러 에이전트 병렬 검증" },
  { name: "/undo", desc: "마지막 변경 되돌리기" },
  { name: "/help", desc: "도움말" },
  { name: "/exit", desc: "종료" },
];

/**
 * Commands matching a bare slash token being typed (no whitespace yet). Shorter
 * names first so an exact/shorter command (/mode) ranks above a longer one that
 * merely shares its prefix (/model) — keeps the ghost preview correct.
 */
export function matchSlash(buf: string): SlashCommand[] {
  if (!buf.startsWith("/") || /\s/.test(buf)) return [];
  const q = buf.toLowerCase();
  return SLASH_COMMANDS
    .filter((c) => c.name.startsWith(q))
    .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
}

export interface SlashSuggest {
  /** the partial token currently being completed */
  token: string;
  /** candidate completions for that token (full values) */
  candidates: string[];
}

/**
 * Suggestions for the current buffer: command names while typing the command,
 * then the first-argument options once a command with args is followed by a
 * space. null when there is nothing to suggest.
 */
export function slashSuggest(buf: string): SlashSuggest | null {
  if (!buf.startsWith("/")) return null;
  const sp = buf.indexOf(" ");
  if (sp === -1) {
    const candidates = matchSlash(buf).map((c) => c.name);
    return candidates.length ? { token: buf, candidates } : null;
  }
  const cmd = SLASH_COMMANDS.find((c) => c.name === buf.slice(0, sp));
  if (!cmd || !cmd.args) return null;
  const rest = buf.slice(sp + 1);
  if (/\s/.test(rest)) return null; // only the first argument is completed
  const candidates = cmd.args.filter((a) => a.toLowerCase().startsWith(rest.toLowerCase()));
  return candidates.length ? { token: rest, candidates } : null;
}

/** Whether a fully-typed command name takes arguments (Tab should add a space). */
export function commandTakesArgs(name: string): boolean {
  return Boolean(SLASH_COMMANDS.find((c) => c.name === name)?.args);
}

/** Replace the trailing token of `buf` with `candidate`. */
export function applyCompletion(buf: string, token: string, candidate: string): string {
  return buf.slice(0, buf.length - token.length) + candidate;
}

/** Longest common prefix of candidates — how far Tab can complete an ambiguous set. */
export function commonPrefix(names: string[]): string {
  if (names.length === 0) return "";
  let p = names[0]!;
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < p.length && i < n.length && p[i] === n[i]) i++;
    p = p.slice(0, i);
  }
  return p;
}
