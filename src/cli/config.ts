// Persistent user config — ~/.omcode/config.json
// Resolution order: environment variable > config file > built-in default.
// So `omcode` just works after first setup, and env vars still override.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

export interface OmcodeConfig {
  host?: string;
  model?: string;
  apiKey?: string;
  numCtx?: number;
  stream?: boolean;
  think?: boolean;
}

export interface Settings {
  host: string;
  model: string;
  apiKey?: string;
  numCtx: number;
  stream: boolean;
  think?: boolean;
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

export function resolveSettings(): Settings {
  const file = loadConfig();
  const env = process.env;
  const boolEnv = (v: string | undefined): boolean | undefined =>
    v === "true" ? true : v === "false" ? false : undefined;

  return {
    host: env["OMCODE_HOST"] ?? file.host ?? "http://localhost:11434",
    model: env["OMCODE_MODEL"] ?? file.model ?? "qwen3:8b",
    apiKey: env["OLLAMA_API_KEY"] ?? file.apiKey,
    numCtx: Number(env["OMCODE_NUM_CTX"] ?? file.numCtx ?? 32_768),
    stream: boolEnv(env["OMCODE_STREAM"]) ?? file.stream ?? true,
    think: boolEnv(env["OMCODE_THINK"]) ?? file.think,
  };
}
