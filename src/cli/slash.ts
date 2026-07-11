// Slash-command autocomplete data + matching. Pure and UI-agnostic so the
// fixed-screen editor can render suggestions and the logic stays testable.

export interface SlashCommand {
  name: string;
  desc: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/init", desc: "저장소 분석해 AGENTS.md 생성" },
  { name: "/model", desc: "모델 전환" },
  { name: "/mode", desc: "scout·check·flow 전환" },
  { name: "/think", desc: "추론 모드 토글" },
  { name: "/compact", desc: "컨텍스트 압축" },
  { name: "/clear", desc: "대화 초기화" },
  { name: "/new", desc: "새 세션 시작" },
  { name: "/cost", desc: "토큰 사용량" },
  { name: "/diff", desc: "세션 변경 diff" },
  { name: "/lint", desc: "언어 검사기 실행" },
  { name: "/test", desc: "테스트 실행" },
  { name: "/status", desc: "현재 상태" },
  { name: "/doctor", desc: "설정 점검" },
  { name: "/config", desc: "설정 보기/저장" },
  { name: "/permissions", desc: "도구 권한" },
  { name: "/mcp", desc: "MCP 서버 상태" },
  { name: "/agents", desc: "서브에이전트" },
  { name: "/undo", desc: "마지막 변경 되돌리기" },
  { name: "/help", desc: "도움말" },
  { name: "/exit", desc: "종료" },
];

/**
 * Commands matching a buffer. Non-empty only while the buffer is a bare slash
 * token still being typed (starts with "/", no whitespace yet) — so suggestions
 * appear as you type "/co" and vanish once you move on to arguments.
 */
export function matchSlash(buf: string): SlashCommand[] {
  if (!buf.startsWith("/") || /\s/.test(buf)) return [];
  const q = buf.toLowerCase();
  // Shorter names first so an exact/shorter command (/mode) ranks above a longer
  // one that merely shares its prefix (/model) — keeps the ghost preview correct.
  return SLASH_COMMANDS
    .filter((c) => c.name.startsWith(q))
    .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
}

/** Longest common prefix of names — how far Tab can complete an ambiguous set. */
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
