// User-defined sub-agents. Each is a markdown file with a small frontmatter
// block (name, description, optional tools/model) followed by the role prompt.
// They live in .omcode/agents/ (project) or ~/.omcode/agents/ (global); project
// wins on a name clash. Loaded once at startup and exposed two ways: the /agents
// command and the run_agent tool the model can call on its own judgement.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

export interface AgentDef {
  name: string;
  description: string;
  /** allowed read-only tool names; undefined = all read-only tools */
  tools?: string[];
  /** model override; undefined = the session model */
  model?: string;
  /** the role prompt (markdown body) */
  prompt: string;
  /** file it came from, for /agents display */
  source: string;
}

/** Directory holding agent files — project-local by default, global with global=true. */
export function agentsDir(global = false, cwd = process.cwd()): string {
  return global ? join(os.homedir(), ".omcode", "agents") : join(cwd, ".omcode", "agents");
}

/** Load all agents (project dir first, then global; first name wins). */
export function loadAgents(cwd = process.cwd()): AgentDef[] {
  const byName = new Map<string, AgentDef>();
  for (const dir of [agentsDir(false, cwd), agentsDir(true, cwd)]) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue; // directory absent — fine
    }
    for (const f of files.sort()) {
      try {
        const def = parseAgentFile(readFileSync(join(dir, f), "utf8"), join(dir, f));
        if (def && !byName.has(def.name)) byName.set(def.name, def);
      } catch {
        // a malformed agent file must never break startup
      }
    }
  }
  return [...byName.values()];
}

/** Parse one agent file: `---` frontmatter `---` then the role prompt body. */
export function parseAgentFile(text: string, source: string): AgentDef | null {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const front = m[1]!;
  const body = m[2]!.trim();
  const get = (key: string): string | undefined => {
    const r = new RegExp(`^${key}\\s*:\\s*(.+)$`, "m").exec(front);
    return r ? r[1]!.trim() : undefined;
  };
  const name = get("name");
  const description = get("description");
  if (!name || !description) return null; // both are required
  const toolsRaw = get("tools");
  const tools = toolsRaw ? toolsRaw.split(/[,\s]+/).filter(Boolean) : undefined;
  return { name, description, tools, model: get("model"), prompt: body || description, source };
}
