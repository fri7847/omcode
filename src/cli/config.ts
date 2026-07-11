// Persistent user config — ~/.omcode/config.json
// Resolution order: environment variable > config file > built-in default.
// So `omcode` just works after first setup, and env vars still override.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { parseAgentMode, type AgentMode } from "../core/agent-mode.js";
import { parseThinkLevel, type ThinkLevel } from "../core/think.js";

export interface OmcodeConfig {
  host?: string;
  model?: string;
  apiKey?: string;
  numCtx?: number;
  stream?: boolean;
  think?: boolean;
  /** Reasoning-effort level (off|low|medium|high|xhigh); overrides `think`. */
  thinkLevel?: ThinkLevel;
  /** Optional cheaper model used only for context condensation. */
  condenseModel?: string;
  mode?: AgentMode;
  /** Hard output-token cap (Ollama num_predict); omit for no cap. */
  maxOutput?: number;
  /** MCP servers to connect at startup, keyed by name (Claude Desktop format). */
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }>;
}

export interface Settings {
  host: string;
  model: string;
  apiKey?: string;
  numCtx: number;
  stream: boolean;
  think?: boolean;
  thinkLevel?: ThinkLevel;
  condenseModel?: string;
  mode: AgentMode;
  maxOutput?: number;
}

export function configFile(): string {
  return join(os.homedir(), ".omcode", "config.json");
}

export function loadConfig(): OmcodeConfig {
  try {
    return JSON.parse(readFileSync(configFile(), "utf8")) as OmcodeConfig;
  } catch {
    return {};
  }
}

export function saveConfig(patch: Partial<OmcodeConfig>): void {
  const merged = { ...loadConfig(), ...patch };
  mkdirSync(join(os.homedir(), ".omcode"), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(merged, null, 2) + "\n", "utf8");
}

export function resolveSettingsFrom(file: OmcodeConfig, env: NodeJS.ProcessEnv): Settings {
  const boolEnv = (v: string | undefined): boolean | undefined =>
    v === "true" ? true : v === "false" ? false : undefined;

  return {
    host: env["OMCODE_HOST"] ?? file.host ?? "http://localhost:11434",
    model: env["OMCODE_MODEL"] ?? file.model ?? "qwen3:8b",
    apiKey: env["OLLAMA_API_KEY"] ?? file.apiKey,
    numCtx: Number(env["OMCODE_NUM_CTX"] ?? file.numCtx ?? 32_768),
    stream: boolEnv(env["OMCODE_STREAM"]) ?? file.stream ?? true,
    think: boolEnv(env["OMCODE_THINK"]) ?? file.think,
    thinkLevel: parseThinkLevel(env["OMCODE_THINK_LEVEL"] ?? file.thinkLevel),
    condenseModel: env["OMCODE_CONDENSE_MODEL"] ?? file.condenseModel,
    mode: parseAgentMode(env["OMCODE_MODE"] ?? file.mode) ?? "ask",
    maxOutput: env["OMCODE_MAX_OUTPUT"] ? Number(env["OMCODE_MAX_OUTPUT"]) : file.maxOutput,
  };
}

export function resolveSettings(): Settings {
  return resolveSettingsFrom(loadConfig(), process.env);
}
