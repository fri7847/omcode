// Workspace boundary for write operations (Codex lesson: protect .git from
// the model — blocks hook injection; and keep writes inside the workspace).

import { resolve, relative, isAbsolute, sep } from "node:path";

export function resolveWritable(
  cwd: string,
  path: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const abs = resolve(cwd, path);
  const rel = relative(cwd, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return {
      ok: false,
      error: `Refused: "${path}" is outside the working directory. Write only within ${cwd}.`,
    };
  }
  if (rel.split(sep).includes(".git")) {
    return {
      ok: false,
      error: `Refused: writes inside .git/ are not allowed. Use shell git commands for repository operations instead.`,
    };
  }
  return { ok: true, path: abs };
}
