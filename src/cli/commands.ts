// Slash-command implementations shared by both frontends (the inline REPL and
// the fixed-screen TUI). Keeping the logic here means the two dispatchers stay
// in sync — they only wire string→function + rendering. Commands with their own
// interactive UI (/model, /mode, /undo) stay in the dispatchers; the rest live here.

import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { renderDiff } from "./diff.js";
import { loadAgents, agentsDir } from "../core/agents.js";
import { projectDiagnostics, projectTest } from "../tools/diagnostics.js";
import { loadConfig, saveConfig, configFile } from "./config.js";
import { parseAgentMode } from "../core/agent-mode.js";
import { contextWindowWarning } from "../model/runtime.js";
import type { McpServerStatus } from "../tools/mcp.js";
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

/** Run the project's language checker on demand (/lint). Deterministic, no model. */
export async function lintProject(cwd: string): Promise<string> {
  const { language, failure } = await projectDiagnostics(cwd);
  if (language === "none") return "no recognized project type to lint (tsconfig.json / go.mod / Python)";
  return failure ?? `${language}: clean — no issues`;
}

/** Run the project's test command on demand (/test). Output tail is capped. */
export async function testProject(cwd: string): Promise<string> {
  const r = await projectTest(cwd);
  if (!r) return "no test command detected (package.json test script / go.mod / Cargo.toml / pytest)";
  const tail = r.output.trim().split("\n").slice(-40).join("\n");
  return `${r.ok ? "✓ passed" : "✗ failed"} · ${r.label}\n${tail || "(no output)"}`;
}

// ---- /status /doctor /config /permissions ----

/** Live session state passed to /status and /doctor (model/mode can change at
 * runtime, so these are read from the running loop, not the frozen settings). */
export interface EnvInfo {
  host: string;
  model: string;
  mode: string;
  numCtx: number;
  think?: boolean;
  stream: boolean;
  hasApiKey: boolean;
  condenseModel?: string;
  maxOutput?: number;
  sessionFile: string;
  cwd: string;
}

/** /status — current session configuration + context usage. No network. */
export function statusText(info: EnvInfo, contextTokens: number): string {
  const pct = info.numCtx ? Math.round((contextTokens / info.numCtx) * 100) : 0;
  return [
    "omcode status",
    `  model     ${info.model}`,
    `  host      ${info.host}${info.hasApiKey ? "  (api key set)" : ""}`,
    `  mode      ${info.mode}`,
    `  context   ${info.numCtx} num_ctx · ${contextTokens} used (${pct}%)`,
    `  think     ${info.think === undefined ? "server default" : String(info.think)}`,
    `  stream    ${info.stream ? "on" : "off"}`,
    info.condenseModel ? `  condense  ${info.condenseModel}` : "",
    info.maxOutput ? `  maxOutput ${info.maxOutput}` : "",
    `  session   ${info.sessionFile}`,
    `  cwd       ${info.cwd}`,
  ].filter(Boolean).join("\n");
}

/** /doctor — actionable health check of the setup (reachability, model, VRAM). */
export async function doctorText(
  info: EnvInfo,
  listModels: () => Promise<string[]>,
  detectVram: () => Promise<number | undefined>,
): Promise<string> {
  const ok = (m: string) => `  ✓ ${m}`;
  const warn = (m: string) => `  ‼ ${m}`;
  const lines: string[] = ["omcode doctor"];

  let models: string[] = [];
  try {
    models = await listModels();
  } catch {
    /* handled below */
  }
  if (models.length === 0) {
    lines.push(warn(`cannot list models from ${info.host} — host unreachable or key missing`));
  } else {
    lines.push(ok(`host reachable (${models.length} models)`));
    lines.push(
      models.includes(info.model)
        ? ok(`model "${info.model}" available`)
        : warn(`model "${info.model}" is not on the host — switch with /model`),
    );
  }
  if (info.host.includes("ollama.com") && !info.hasApiKey) {
    lines.push(warn(`Ollama Cloud host but no API key — set it in ${configFile()}`));
  }
  if (/localhost|127\.0\.0\.1|\[::1\]/.test(info.host)) {
    const vram = await detectVram();
    if (vram) {
      const w = contextWindowWarning(info.model, info.numCtx, vram);
      lines.push(w ? warn(w) : ok(`num_ctx ${info.numCtx} fits ${vram} MiB VRAM`));
    } else {
      lines.push("  · no NVIDIA GPU detected (nvidia-smi) — VRAM check skipped");
    }
  }
  return lines.join("\n");
}

const CONFIG_KEYS = ["host", "model", "apiKey", "numCtx", "stream", "think", "condenseModel", "mode", "maxOutput"] as const;

/** /config with no args — show the file path and current contents. */
export function configText(): string {
  return `config file: ${configFile()}\n${JSON.stringify(loadConfig(), null, 2)}`;
}

/** /config <key> <value> — persist a single setting (validated). */
export function setConfig(key: string, value: string): string {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    return `unknown key "${key}". known keys: ${CONFIG_KEYS.join(", ")}`;
  }
  let v: unknown = value;
  if (key === "numCtx" || key === "maxOutput") {
    v = Number(value);
    if (!Number.isFinite(v)) return `${key} must be a number`;
  } else if (key === "stream" || key === "think") {
    if (value !== "true" && value !== "false") return `${key} must be true or false`;
    v = value === "true";
  } else if (key === "mode") {
    const m = parseAgentMode(value);
    if (!m) return "mode must be architect or editor";
    v = m;
  }
  saveConfig({ [key]: v });
  const live = key === "model" || key === "mode" ? "" : " — restart to apply";
  return `saved ${key} = ${value} → ${configFile()}${live}`;
}

/** /permissions — list tools + levels, or set a session override with allow|ask <tool>. */
export function permissions(loop: AgentLoop, args: string[]): string {
  const [verb, tool] = args;
  if (verb === "allow" || verb === "ask") {
    if (!tool) return `usage: /permissions ${verb} <tool>`;
    const okSet = loop.setToolAlways(tool, verb === "allow");
    return okSet ? `${tool}: ${verb === "allow" ? "always allowed" : "will ask"} (this session)` : `unknown tool "${tool}"`;
  }
  const rows = loop.toolPermissions().map((p) => {
    const eff = p.always ? "allow (session)" : p.permission;
    return `  ${p.name.padEnd(12)} ${eff.padEnd(16)} ${p.readOnly ? "read-only" : "mutating"}`;
  });
  return ["tool permissions  (·  /permissions allow|ask <tool>  overrides for this session)", ...rows].join("\n");
}

// ---- /agents ----

/** /agents — list user-defined sub-agents (the model can call them via run_agent). */
export function agentsText(cwd: string): string {
  const agents = loadAgents(cwd);
  if (agents.length === 0) {
    return (
      "no sub-agents defined.\n" +
      `  create one:  /agents new <name>   → writes ${join(agentsDir(false, cwd), "<name>.md")}\n` +
      "  a *.md file: frontmatter (name, description, optional tools/model) then the role prompt.\n" +
      "  once defined, the model calls it automatically via run_agent when it fits — or you can name it."
    );
  }
  const rows = agents.map(
    (a) =>
      `  ${a.name}\n    ${a.description}\n` +
      `    tools: ${a.tools?.join(", ") ?? "read-only default"} · model: ${a.model ?? "session model"}\n` +
      `    ${a.source}`,
  );
  return ["sub-agents  (callable by the model via run_agent, or ask for one by name)", ...rows].join("\n");
}

/** /agents new <name> — scaffold a project agent file to edit. */
export function newAgentScaffold(cwd: string, name: string): string {
  if (!/^[\w-]+$/.test(name)) return `invalid name "${name}" — use letters, digits, - or _`;
  const file = join(agentsDir(false, cwd), `${name}.md`);
  if (existsSync(file)) return `already exists: ${file}`;
  mkdirSync(agentsDir(false, cwd), { recursive: true });
  writeFileSync(file, agentTemplate(name), "utf8");
  return `created ${file} — edit it, then restart omcode to activate the agent.`;
}

function agentTemplate(name: string): string {
  return (
    `---\n` +
    `name: ${name}\n` +
    `description: One line on what this agent does and WHEN to use it (the model reads this to decide whether to delegate).\n` +
    `tools: read, grep, glob, repo_map\n` +
    `model:\n` +
    `---\n` +
    `You are the ${name} agent. State the role, what to look for, and the exact format of the report to return.\n`
  );
}

/** /mcp — configured MCP servers, their connection status and discovered tools. */
export function mcpStatusText(statuses: McpServerStatus[]): string {
  if (statuses.length === 0) {
    return `no MCP servers configured — add an "mcpServers" object to ${configFile()}\n` +
      `  example: { "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } } }`;
  }
  const rows = statuses.map((s) =>
    s.ok
      ? `  ✓ ${s.name}  (${s.tools.length} tool${s.tools.length === 1 ? "" : "s"}${s.tools.length ? ": " + s.tools.join(", ") : ""})`
      : `  ‼ ${s.name}  failed: ${s.error ?? "unknown error"}`,
  );
  return ["mcp servers", ...rows].join("\n");
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
