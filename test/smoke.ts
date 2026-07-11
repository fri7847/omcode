// End-to-end smoke test: one real turn against a live Ollama model.
// Non-interactive: read-only tools auto-allowed, shell auto-denied.
// Usage: tsx test/smoke.ts [model] ["question"]

import { AgentLoop, type LoopUI } from "../src/core/loop.js";
import { SessionLog } from "../src/core/session.js";
import { OllamaProvider } from "../src/model/ollama.js";
import { buildSystemPrompt } from "../src/prompt/system.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { readTool } from "../src/tools/read.js";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";
import { detectShell, makeShellTool } from "../src/tools/shell.js";

const model = process.argv[2] ?? process.env["OMCODE_MODEL"] ?? "qwen3-coder:480b";
const question =
  process.argv[3] ??
  'Read package.json in this project and tell me the value of its "name" field and how many dependencies it has.';

const provider = new OllamaProvider({
  host: process.env["OMCODE_HOST"] ?? "http://localhost:11434",
  apiKey: process.env["OLLAMA_API_KEY"],
  timeoutMs: 120_000,
});

const registry = new ToolRegistry();
const shell = detectShell();
registry.register(readTool);
registry.register(globTool);
registry.register(grepTool);
registry.register(makeShellTool(shell));

const ui: LoopUI = {
  onAssistantText: (t) => console.log(`[assistant] ${t}`),
  onToolStart: (c) => console.log(`[tool→] ${c.name} ${JSON.stringify(c.arguments)}`),
  onToolEnd: (c, r) => console.log(`[tool✓] ${c.name} → ${r.slice(0, 150).replace(/\n/g, " ⏎ ")}`),
  onNotice: (m) => console.log(`[notice] ${m}`),
  askPermission: async () => {
    console.log("[perm] auto-DENY (non-interactive smoke test)");
    return "no" as const;
  },
};

const loop = new AgentLoop(
  provider,
  registry,
  { model, numCtx: Number(process.env["OMCODE_NUM_CTX"] ?? 32_768), maxToolCallsPerTurn: 10 },
  ui,
  new SessionLog(),
  { cwd: process.cwd() },
  buildSystemPrompt(process.cwd(), shell.label),
);

console.log(`[smoke] model=${model} question=${question}\n`);
const t0 = Date.now();
const stats = await loop.runTurn(question);
console.log(
  `\n[smoke done] ${((Date.now() - t0) / 1000).toFixed(1)}s · requests=${stats.requests} tools=${stats.toolCalls} recovered=${stats.recoveredCalls} tokens=${stats.promptTokens}↑${stats.completionTokens}↓`,
);
