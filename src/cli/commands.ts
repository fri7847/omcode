// Slash-command implementations shared by both frontends (the inline REPL and
// the fixed-screen TUI). Keeping the logic here means the two dispatchers stay
// in sync — they only wire string→function + rendering. Commands with their own
// interactive UI (/model, /mode, /undo) stay in the dispatchers; the rest live here.

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { renderDiff } from "./diff.js";
import type { AgentLoop } from "../core/loop.js";

/** Just the slice of CheckpointStore /diff needs (keeps the frontends decoupled). */
interface Originals {
  originals(): { path: string; before: string | null }[];
}

/** The /init instruction — run as a normal turn so the whole agent loop (repo_map,
 * read, write-with-approval) is reused. The model writes AGENTS.md itself. */
export const INIT_PROMPT =
  "Analyze THIS repository and create a concise AGENTS.md file at the project root to help a coding agent work here. " +
  "Steps: call repo_map for an overview, read the README and the package/manifest and 2-3 central source files, then write AGENTS.md with the write tool. " +
  "Include ONLY what is true of this repo: the build/test/run commands, the high-level architecture and where the key logic lives, and any non-obvious conventions. " +
  "Keep it under 40 lines. Do not invent commands you did not verify.";

/** Force-condense the live context now (/compact). */
export async function compactNow(loop: AgentLoop): Promise<string> {
  const r = await loop.compactNow();
  if (!r.condensed) return "nothing to compact yet — not enough older turns to summarize";
  const saved = Math.max(0, r.before - r.after);
  return `compacted older turns into a summary — ~${saved} tokens reclaimed (${r.before}→${r.after} est)`;
}

/** Reset the conversation, keeping model/mode/session file (/clear). */
export function clearConversation(loop: AgentLoop): string {
  loop.clear();
  return "conversation cleared — starting fresh (model, mode, and session unchanged)";
}

/** Combined diff of every file changed this session (/diff). */
export async function sessionDiff(
  checkpoints: Originals,
  cwd: string,
  color: boolean,
): Promise<string> {
  const originals = checkpoints.originals();
  if (originals.length === 0) return "no files have been changed this session";

  const blocks: string[] = [];
  for (const { path, before } of originals) {
    let after: string | null;
    try {
      after = await readFile(path, "utf8");
    } catch {
      after = null;
    }
    if (before === after) continue;
    const rel = relative(cwd, path) || path;
    if (after === null) blocks.push(`   ${rel}  (deleted)`);
    else if (before === null) blocks.push(renderDiff("", after, { color, indent: "   ", path: `${rel} (new)` }));
    else blocks.push(renderDiff(before, after, { color, indent: "   ", path: rel }));
  }
  return blocks.length ? blocks.join("\n\n") : "no net changes this session";
}

/** Read the project's agent guide (AGENTS.md preferred) to inject into the system
 * prompt. Bounded so a huge file can't blow up every request. */
export async function loadProjectContext(cwd: string): Promise<string> {
  for (const name of ["AGENTS.md", ".omcode/AGENTS.md", "CLAUDE.md"]) {
    try {
      const txt = await readFile(join(cwd, name), "utf8");
      if (txt.trim()) return txt.trim().slice(0, 6000);
    } catch {
      // not present — try the next candidate
    }
  }
  return "";
}
