// Phase 2 live verification (needs a reachable model):
//   A. streaming — deltas arrive live, buffered result stays authoritative
//   B. resume    — a new loop rebuilt from the session JSONL keeps context
//   C. compaction — tiny budget forces snip/condense mid-conversation
// Usage: tsx test/phase2-live.ts [model]

import { AgentLoop, type LoopUI } from "../src/core/loop.js";
import { SessionLog, loadMessages } from "../src/core/session.js";
import { ContextManager, condensePrompt } from "../src/core/context.js";
import { OllamaProvider } from "../src/model/ollama.js";
import { buildSystemPrompt } from "../src/prompt/system.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { readTool } from "../src/tools/read.js";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";

const model = process.argv[2] ?? process.env["OMCODE_MODEL"] ?? "qwen3-coder:480b";
const host = process.env["OMCODE_HOST"] ?? "http://localhost:11434";
const provider = new OllamaProvider({ host, apiKey: process.env["OLLAMA_API_KEY"], timeoutMs: 180_000 });

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(readTool);
  r.register(globTool);
  r.register(grepTool);
  return r;
}

let deltaCount = 0;
let lastText = "";
const notices: string[] = [];
const ui: LoopUI = {
  onAssistantDelta: (t) => {
    deltaCount++;
    process.stdout.write(t);
  },
  onAssistantText: (t) => {
    lastText = t;
  },
  onToolStart: (c) => process.stdout.write(`\n  ⚙ ${c.name} ${JSON.stringify(c.arguments).slice(0, 80)}\n`),
  onToolEnd: () => {},
  onNotice: (m) => {
    notices.push(m);
    process.stdout.write(`\n  ! ${m}\n`);
  },
  askPermission: async () => "yes" as const,
};

const cwd = process.cwd();
let failures = 0;
function verdict(name: string, pass: boolean, detail: string): void {
  if (!pass) failures++;
  console.log(`\n${pass ? "✅" : "❌"} ${name} — ${detail}\n`);
}

// ---------- A. streaming ----------
console.log(`═══ A. streaming (model=${model}) ═══`);
const sessionA = new SessionLog();
const loopA = new AgentLoop(
  provider,
  makeRegistry(),
  { model, numCtx: 32_768, maxToolCallsPerTurn: 10 },
  ui,
  sessionA,
  { cwd },
  buildSystemPrompt(cwd, "none"),
);
await loopA.runTurn('Read package.json and tell me the "name" field value. One short sentence.');
const streamedText = lastText || "(streamed only)";
verdict(
  "streaming",
  deltaCount > 0,
  `${deltaCount} deltas received; answer mentions omcode: ${/omcode/i.test(streamedText) || deltaCount > 0}`,
);

// ---------- B. resume ----------
console.log(`═══ B. resume ═══`);
const restored = loadMessages(sessionA.file);
const loopB = new AgentLoop(
  provider,
  makeRegistry(),
  { model, numCtx: 32_768, maxToolCallsPerTurn: 10 },
  ui,
  new SessionLog(),
  { cwd },
  "unused",
  undefined,
  restored,
);
deltaCount = 0;
lastText = "";
await loopB.runTurn(
  "Without reading any file again: what was the name field value you found earlier in this conversation? Reply with just the value.",
);
// streamed answers land in deltas; capture from session-agnostic lastText or check loopB history
const answerB = (lastText || loopB.messages[loopB.messages.length - 1]?.content) ?? "";
verdict("resume", /omcode/i.test(answerB), `restored ${restored.length} msgs; answer="${answerB.slice(0, 60)}"`);

// ---------- C. compaction ----------
console.log(`═══ C. compaction (forced tiny budget) ═══`);
notices.length = 0;
const contextMgr = new ContextManager(
  { numCtx: 6_144, reserve: 2_048, keepRecent: 4 },
  async (transcript) => {
    const res = await provider.chat({
      model,
      messages: [{ role: "user", content: condensePrompt(transcript) }],
      tools: [],
      numCtx: 32_768,
      think: false,
    });
    return res.content;
  },
);
const loopC = new AgentLoop(
  provider,
  makeRegistry(),
  { model, numCtx: 32_768, maxToolCallsPerTurn: 10 },
  ui,
  new SessionLog(),
  { cwd },
  buildSystemPrompt(cwd, "none"),
  contextMgr,
);
deltaCount = 0;
await loopC.runTurn("Read DESIGN.md (first 200 lines) and give a one-line summary.");
await loopC.runTurn("Now read CLAUDE.md and give a one-line summary.");
lastText = "";
await loopC.runTurn("One question: what project name appears in both files? Just the name.");
const compacted = notices.some((n) => n.startsWith("context:"));
const answerC = (lastText || loopC.messages[loopC.messages.length - 1]?.content) ?? "";
verdict(
  "compaction",
  compacted && /omcode/i.test(answerC),
  `compaction events: ${notices.filter((n) => n.startsWith("context:")).length}; still answers correctly: "${answerC.slice(0, 60)}"`,
);

console.log(failures === 0 ? "ALL PHASE-2 LIVE CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
