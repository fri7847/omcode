// Phase 0 harness tests — everything that must work WITHOUT a model.
// The io-guard and loop-breaker are the parts that absorb model mistakes;
// they must be provably correct before we blame any model.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { z } from "zod";
import { guard, stripThink, isDegenerate } from "../src/model/io-guard.js";
import { LoopBreaker } from "../src/policy/loop-breaker.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { readTool } from "../src/tools/read.js";
import { applyEdit } from "../src/tools/applier.js";
import { resolveWritable } from "../src/tools/fs-guard.js";
import { StreamAccumulator } from "../src/model/ollama.js";
import { ContextManager } from "../src/core/context.js";
import { CheckpointStore } from "../src/core/checkpoint.js";
import { loadMessages } from "../src/core/session.js";
import type { ChatMessage } from "../src/model/provider.js";
import { lineDiff, diffStat, renderDiff, collapseContext } from "../src/cli/diff.js";
import { buildRepoMap, renderRepoMap } from "../src/core/repo-map.js";
import { resolveSettingsFrom } from "../src/cli/config.js";
import { blocksTool, parseAgentMode } from "../src/core/agent-mode.js";
import { typecheckCommand } from "../src/tools/typecheck.js";
import { makeTaskTool } from "../src/tools/task.js";
import { contextWindowWarning, recommendedNumCtx } from "../src/model/runtime.js";
import { AgentLoop, type LoopUI } from "../src/core/loop.js";
import { SessionLog } from "../src/core/session.js";
import type { Provider } from "../src/model/provider.js";

let passed = 0;
const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

async function runTests(): Promise<void> {
  for (const { name, fn } of tests) {
    try {
      await fn();
    passed++;
    console.log(`  ok  ${name}`);
    } catch (err) {
      console.error(`FAIL  ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }
}

const base = { doneReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } };

// ---- io-guard: think stripping ----
test("strips closed think blocks", () => {
  assert.equal(stripThink("<think>internal</think>hello"), "hello");
});
test("strips unclosed trailing think block", () => {
  assert.equal(stripThink("hello<think>never closed"), "hello");
});

// ---- io-guard: native calls pass through ----
test("native tool calls pass through untouched", () => {
  const g = guard({
    ...base,
    content: "",
    toolCalls: [{ id: "1", name: "read", arguments: { path: "a.ts" } }],
  });
  assert.equal(g.kind, "tool-calls");
  assert.equal(g.toolCallSource, "native");
  assert.equal(g.toolCalls.length, 1);
});

// ---- io-guard: XML recovery (Hermes-style, Qwen family) ----
test("recovers <tool_call> XML from text", () => {
  const g = guard({
    ...base,
    content: 'Let me check.\n<tool_call>\n{"name": "read", "arguments": {"path": "a.ts"}}\n</tool_call>',
    toolCalls: [],
  });
  assert.equal(g.toolCallSource, "recovered-xml");
  assert.equal(g.toolCalls[0]?.name, "read");
  assert.deepEqual(g.toolCalls[0]?.arguments, { path: "a.ts" });
  assert.equal(g.content, "Let me check.");
});

// ---- io-guard: JSON recovery ----
test("recovers fenced JSON tool call", () => {
  const g = guard({
    ...base,
    content: '```json\n{"name": "grep", "arguments": {"pattern": "TODO"}}\n```',
    toolCalls: [],
  });
  assert.equal(g.toolCallSource, "recovered-json");
  assert.equal(g.toolCalls[0]?.name, "grep");
});
test("recovers bare JSON object covering whole message", () => {
  const g = guard({
    ...base,
    content: '{"name": "glob", "parameters": {"pattern": "**/*.ts"}}',
    toolCalls: [],
  });
  assert.equal(g.toolCallSource, "recovered-json");
  assert.equal(g.toolCalls[0]?.name, "glob");
});
test("does NOT eat ordinary JSON in prose", () => {
  const g = guard({
    ...base,
    content: 'The config is:\n```json\n{"port": 8080, "debug": true}\n```',
    toolCalls: [],
  });
  assert.equal(g.kind, "text");
  assert.equal(g.toolCalls.length, 0);
  assert.match(g.content, /8080/);
});

// ---- io-guard: empty classification (Qwen Code #2530 lesson) ----
test("empty content with no calls classifies as empty-end-turn", () => {
  const g = guard({ ...base, content: "", toolCalls: [] });
  assert.equal(g.kind, "empty-end-turn");
});
test("think-only content classifies as empty-end-turn", () => {
  const g = guard({ ...base, content: "<think>hmm</think>", toolCalls: [] });
  assert.equal(g.kind, "empty-end-turn");
});

// ---- loop breaker: escalation ladder ----
test("loop breaker: proceed → nudge → halt on identical calls", () => {
  const lb = new LoopBreaker();
  const call = { id: "1", name: "read", arguments: { path: "a.ts" } };
  assert.equal(lb.check(call).action, "proceed");
  assert.equal(lb.check({ ...call, id: "2" }).action, "nudge");
  assert.equal(lb.check({ ...call, id: "3" }).action, "halt");
});
test("loop breaker: argument order does not matter", () => {
  const lb = new LoopBreaker();
  lb.check({ id: "1", name: "grep", arguments: { pattern: "x", glob: "*.ts" } });
  const v = lb.check({ id: "2", name: "grep", arguments: { glob: "*.ts", pattern: "x" } });
  assert.equal(v.action, "nudge");
});
test("loop breaker: different args proceed freely", () => {
  const lb = new LoopBreaker();
  assert.equal(lb.check({ id: "1", name: "read", arguments: { path: "a.ts" } }).action, "proceed");
  assert.equal(lb.check({ id: "2", name: "read", arguments: { path: "b.ts" } }).action, "proceed");
});

// ---- registry: self-correction-guide errors ----
test("unknown tool error lists available tools", () => {
  const reg = new ToolRegistry();
  reg.register(readTool);
  const v = reg.validate("reed", {});
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.error, /Available tools: read/);
});
test("invalid args error names the exact field and instructs a retry", () => {
  const reg = new ToolRegistry();
  reg.register(readTool);
  const v = reg.validate("read", { offset: 1 }); // missing path
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.match(v.error, /path/);
    assert.match(v.error, /call "read" again/);
  }
});
test("valid args parse", () => {
  const reg = new ToolRegistry();
  reg.register(readTool);
  const v = reg.validate("read", { path: "a.ts", limit: 10 });
  assert.equal(v.ok, true);
});

// ---- registry: JSON schema generation ----
test("tool schemas serialize to JSON Schema", () => {
  const reg = new ToolRegistry();
  reg.register(readTool);
  const schemas = reg.schemas();
  assert.equal(schemas[0]?.name, "read");
  const params = schemas[0]?.parameters as { properties?: Record<string, unknown> };
  assert.ok(params.properties?.["path"]);
});

// ---- repo map: compact multi-file routing without a parser dependency ----
test("repo map: ranks imported shared modules and lists definitions", () => {
  const map = buildRepoMap([
    { path: "src/main.ts", content: 'import { add } from "./math";\nexport function run() { return add(1, 2); }' },
    { path: "src/other.ts", content: 'import { add } from "./math";\nexport const value = add(3, 4);' },
    { path: "src/math.ts", content: "export function add(a: number, b: number) { return a + b; }" },
  ]);
  assert.equal(map[0]?.path, "src/math.ts");
  assert.match(renderRepoMap(map), /add:1/);
});
test("repo map: focus boosts the requested file or symbol", () => {
  const map = buildRepoMap([
    { path: "src/entry.ts", content: "export function entry() {}" },
    { path: "src/worker.ts", content: "export function calculate() {}" },
  ], { focus: "calculate" });
  assert.equal(map[0]?.path, "src/worker.ts");
});

test("config: a dedicated condenser model is opt-in and env-overridable", () => {
  const fromFile = resolveSettingsFrom({ model: "main", condenseModel: "small" }, {});
  assert.equal(fromFile.condenseModel, "small");
  const fromEnv = resolveSettingsFrom({ condenseModel: "small" }, { OMCODE_CONDENSE_MODEL: "tiny" });
  assert.equal(fromEnv.condenseModel, "tiny");
});
test("agent mode: only architect blocks mutations", () => {
  assert.equal(parseAgentMode("architect"), "architect");
  assert.equal(parseAgentMode("bad"), undefined);
  assert.equal(blocksTool("architect", false), true);
  assert.equal(blocksTool("architect", true), false);
  assert.equal(blocksTool("editor", false), false);
});
test("agent mode: the loop blocks a mutation before tool execution", async () => {
  let executed = false;
  let request = 0;
  const provider: Provider = {
    name: "fake",
    async chat() {
      request++;
      return request === 1
        ? { content: "", toolCalls: [{ id: "1", name: "mutate", arguments: {} }], doneReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1 } }
        : { content: "plan complete", toolCalls: [], doneReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
  const registry = new ToolRegistry();
  registry.register({
    name: "mutate",
    description: "test mutation",
    schema: z.object({}),
    readOnly: false,
    permission: "allow",
    async execute() { executed = true; return "mutated"; },
  });
  const results: string[] = [];
  const ui: LoopUI = {
    onAssistantText() {}, onToolStart() {}, onToolEnd: (_call, result) => results.push(result), onNotice() {},
    async askPermission() { return "yes"; },
  };
  const session = new SessionLog(mkdtempSync(join(os.tmpdir(), "omcode-mode-")));
  const loop = new AgentLoop(
    provider, registry, { model: "fake", numCtx: 1024, maxToolCallsPerTurn: 3, mode: "architect" },
    ui, session, { cwd: process.cwd() }, "system prompt",
  );
  await loop.runTurn("make a plan");
  assert.equal(executed, false);
  assert.match(results[0] ?? "", /Architect mode blocks/);
});
test("loop: appends post-edit diagnostics only after a successful mutation", async () => {
  let request = 0;
  const provider: Provider = {
    name: "fake",
    async chat() {
      request++;
      return request === 1
        ? { content: "", toolCalls: [{ id: "1", name: "mutate", arguments: {} }], doneReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1 } }
        : { content: "fixed", toolCalls: [], doneReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
  const registry = new ToolRegistry();
  registry.register({
    name: "mutate", description: "test mutation", schema: z.object({}), readOnly: false, permission: "allow",
    async execute() { return "Applied: changed test.ts"; },
  });
  const results: string[] = [];
  const ui: LoopUI = {
    onAssistantText() {}, onToolStart() {}, onToolEnd: (_call, result) => results.push(result), onNotice() {},
    async askPermission() { return "yes"; },
  };
  const session = new SessionLog(mkdtempSync(join(os.tmpdir(), "omcode-diag-")));
  const loop = new AgentLoop(
    provider, registry, { model: "fake", numCtx: 1024, maxToolCallsPerTurn: 3 }, ui, session,
    { cwd: process.cwd(), postEditDiagnostics: async () => "TypeScript diagnostics failed: test.ts:1" }, "system prompt",
  );
  await loop.runTurn("edit it");
  assert.match(results[0] ?? "", /\[post-edit diagnostics\]/);
  assert.match(results[0] ?? "", /test\.ts:1/);
});
test("typecheck: invokes TypeScript through Node without a platform shell", () => {
  const command = typecheckCommand("/repo", "node");
  assert.equal(command.command, "node");
  assert.deepEqual(command.args, [join("/repo", "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--pretty", "false"]);
});
test("task tool: returns only the isolated runner report", async () => {
  const task = makeTaskTool(async (description, maxToolCalls) => `report:${description}:${maxToolCalls}`);
  assert.equal(await task.execute({ description: "find callers", maxToolCalls: 3 }, { cwd: process.cwd() }), "report:find callers:3");
});
test("runtime: warns instead of silently overcommitting local VRAM", () => {
  assert.equal(recommendedNumCtx("qwen3:8b", 8_192), 8_192);
  assert.match(contextWindowWarning("qwen3:8b", 32_768, 8_192) ?? "", /OMCODE_NUM_CTX=8192/);
  assert.equal(contextWindowWarning("qwen3:8b", 8_192, 8_192), undefined);
});

// ---- applier: matching ladder ----
const FILE = [
  "function add(a, b) {",
  "  return a + b;",
  "}",
  "",
  "function sub(a, b) {",
  "  return a - b;",
  "}",
].join("\n");

test("applier: exact match applies", () => {
  const r = applyEdit({ content: FILE, search: "  return a + b;", replace: "  return a + b + 0;" });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.method, "exact");
    assert.match(r.content, /a \+ b \+ 0/);
  }
});

test("applier: whitespace drift matches via normalized", () => {
  const r = applyEdit({
    content: FILE,
    search: "return a + b;", // missing indentation
    replace: "  return Math.round(a + b);",
  });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.method, "normalized");
});

test("applier: near-miss matches via fuzzy", () => {
  const r = applyEdit({
    content: FILE,
    search: "function add(a,b) {\n  return a + b;\n}", // spacing differs inside line
    replace: "function add(a, b) {\n  return a + b + 1;\n}",
  });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.method, "fuzzy");
});

test("applier: fuzzy honors startLine hint on duplicated code", () => {
  const dup = ["// block", "let x = 1;", "", "// block", "let x = 1;"].join("\n");
  const r = applyEdit({ content: dup, search: "// block\nlet x = 1 ;", replace: "// block\nlet x = 2;", startLine: 4 });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.line, 4);
    const lines = r.content.split("\n");
    assert.equal(lines[1], "let x = 1;"); // first block untouched
    assert.equal(lines[4], "let x = 2;"); // second block changed
  }
});

test("applier: ambiguous exact match is rejected with guidance", () => {
  const dup = "let x = 1;\nlet x = 1;";
  const r = applyEdit({ content: dup, search: "let x = 1;", replace: "let x = 2;" });
  assert.ok(!r.ok);
  if (!r.ok) assert.match(r.error, /multiple locations/);
});

test("applier: failure shows the closest real content with line numbers", () => {
  const r = applyEdit({ content: FILE, search: "return a * b;", replace: "return a / b;" });
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.match(r.error, /\d+\| /); // shows numbered file content
    assert.match(r.error, /similarity/);
  }
});

test("applier: empty search redirects to write", () => {
  const r = applyEdit({ content: FILE, search: "", replace: "x" });
  assert.ok(!r.ok);
  if (!r.ok) assert.match(r.error, /write tool/);
});

test("applier: CRLF file preserves CRLF", () => {
  const crlf = "a\r\nb\r\nc";
  const r = applyEdit({ content: crlf, search: "b", replace: "B" });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.content, "a\r\nB\r\nc");
});

// ---- fs-guard ----
test("fs-guard: blocks path escape and .git, allows workspace paths", () => {
  const cwd = process.cwd();
  assert.equal(resolveWritable(cwd, "src/ok.ts").ok, true);
  assert.equal(resolveWritable(cwd, "../outside.ts").ok, false);
  assert.equal(resolveWritable(cwd, ".git/hooks/pre-commit").ok, false);
});

// ---- Phase 2: degenerate output detection ----
test("degenerate: long single-char run detected", () => {
  assert.equal(isDegenerate("0".repeat(100)), true);
});
test("degenerate: repeated token salad detected", () => {
  assert.equal(isDegenerate(Array(30).fill("token").join(" ")), true);
});
test("degenerate: normal code with separators is NOT degenerate", () => {
  const code = `// ${"=".repeat(40)}\nfunction ok() {\n  return 1;\n}\n// ${"=".repeat(40)}\nconst x = [1,2,3];`;
  assert.equal(isDegenerate(code), false);
});
test("degenerate: guard classifies it and empties content", () => {
  const g = guard({
    content: "1".repeat(300),
    toolCalls: [],
    doneReason: "stop",
    usage: { promptTokens: 0, completionTokens: 0 },
  });
  assert.equal(g.kind, "degenerate");
});

// ---- Phase 2: stream accumulator (Qwen Code #2402 regression tests) ----
test("stream: duplicate empty finish chunk does NOT clobber tool calls", () => {
  const acc = new StreamAccumulator();
  acc.add({ message: { content: "checking " } });
  acc.add({
    message: { tool_calls: [{ function: { name: "read", arguments: { path: "a.ts" } } }] },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 100,
    eval_count: 20,
  });
  acc.add({ done: true }); // duplicate empty finish (OpenRouter/GLM pattern)
  assert.equal(acc.toolCalls.length, 1);
  assert.equal(acc.content, "checking ");
  assert.equal(acc.promptTokens, 100);
  assert.equal(acc.doneReason, "stop");
});
test("stream: deltas accumulate in order", () => {
  const acc = new StreamAccumulator();
  const outs: string[] = [];
  for (const piece of ["Hel", "lo ", "world"]) {
    outs.push(acc.add({ message: { content: piece } }).textDelta);
  }
  assert.equal(acc.content, "Hello world");
  assert.deepEqual(outs, ["Hel", "lo ", "world"]);
});

// ---- Phase 2: context manager ----
test("context: under budget → untouched", async () => {
  const cm = new ContextManager({ numCtx: 32768, reserve: 4096, keepRecent: 4 });
  const msgs: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" },
  ];
  const r = await cm.ensure(msgs, 100);
  assert.equal(r.snipped, 0);
  assert.equal(r.condensed, false);
  assert.equal(msgs.length, 2);
});
test("context: over budget → snips old tool results first (0 tokens)", async () => {
  const cm = new ContextManager({ numCtx: 2048, reserve: 512, keepRecent: 2 });
  const big = "x".repeat(6000);
  const msgs: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "do stuff" },
    { role: "tool", content: big, toolName: "read" },
    { role: "assistant", content: "done" },
    { role: "user", content: "next" },
  ];
  const r = await cm.ensure(msgs, 0);
  assert.ok(r.snipped >= 1);
  assert.match(msgs[2]!.content, /^\[snipped by harness:/);
  assert.ok(msgs[2]!.content.length < 400);
});
test("context: condenses via LLM when snip is not enough, keeps recent verbatim", async () => {
  const cm = new ContextManager(
    { numCtx: 1024, reserve: 256, keepRecent: 2 },
    async () => "SUMMARY-MARKER",
  );
  const msgs: ChatMessage[] = [
    { role: "system", content: "sys" },
    ...Array.from({ length: 10 }, (_, i): ChatMessage => ({
      role: i % 2 ? "assistant" : "user",
      content: `turn ${i} ${"y".repeat(400)}`,
    })),
    { role: "user", content: "LATEST-QUESTION" },
  ];
  const r = await cm.ensure(msgs, 0);
  assert.equal(r.condensed, true);
  assert.equal(msgs[0]!.role, "system");
  assert.match(msgs[1]!.content, /SUMMARY-MARKER/);
  assert.match(msgs[msgs.length - 1]!.content, /LATEST-QUESTION/);
});

// ---- Phase 2: checkpoint / undo ----
test("checkpoint: undo restores modified file and deletes created file", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "omcode-ckpt-"));
  const existing = join(dir, "a.txt");
  const created = join(dir, "new.txt");
  writeFileSync(existing, "original", "utf8");

  const store = new CheckpointStore();
  store.beginTurn();
  await store.snapshot(existing);
  writeFileSync(existing, "modified", "utf8");
  await store.snapshot(created); // does not exist yet
  writeFileSync(created, "brand new", "utf8");

  const restored = await store.undoLastTurn();
  assert.equal(restored.length, 2);
  assert.equal(readFileSync(existing, "utf8"), "original");
  assert.equal(existsSync(created), false);
});

// ---- Phase 2: session resume ----
test("session: loadMessages rebuilds history from JSONL", () => {
  const dir = mkdtempSync(join(os.tmpdir(), "omcode-sess-"));
  const file = join(dir, "s.jsonl");
  const events = [
    { ts: "t", type: "system", content: "sys prompt" },
    { ts: "t", type: "user", content: "hi" },
    {
      ts: "t",
      type: "assistant",
      content: "",
      toolCalls: [{ id: "1", name: "read", arguments: { path: "a" } }],
    },
    { ts: "t", type: "tool", name: "read", result: "file body" },
    { ts: "t", type: "assistant", content: "answer", toolCalls: [] },
  ];
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n{torn line", "utf8");
  const msgs = loadMessages(file);
  assert.equal(msgs.length, 5);
  assert.equal(msgs[0]!.role, "system");
  assert.equal(msgs[2]!.toolCalls?.[0]?.name, "read");
  assert.equal(msgs[3]!.role, "tool");
  assert.equal(msgs[3]!.toolName, "read");
  assert.equal(msgs[4]!.content, "answer");
});

// ---- diff engine ----
test("lineDiff: detects add/del/ctx", () => {
  const d = lineDiff("a\nb\nc", "a\nB\nc");
  const kinds = d.map((l) => l.kind);
  assert.deepEqual(kinds, ["ctx", "del", "add", "ctx"]);
});
test("diffStat: counts changed lines", () => {
  const s = diffStat("a\nb\nc\n", "a\nX\nY\nc\n");
  assert.equal(s.removed, 1);
  assert.equal(s.added, 2);
});
test("diffStat: identical → zero", () => {
  const s = diffStat("a\nb\n", "a\nb\n");
  assert.equal(s.added, 0);
  assert.equal(s.removed, 0);
});
test("renderDiff (no color): gutter signs + line numbers", () => {
  const out = renderDiff("let x = 1;\n", "let x = 2;\n", { color: false });
  assert.match(out, / 1 - let x = 1;/);
  assert.match(out, / 1 \+ let x = 2;/);
});
test("renderDiff (color): emits background ANSI for changes", () => {
  const out = renderDiff("a\n", "b\n", { color: true });
  assert.match(out, /\x1b\[48;2;/); // a background-fill escape is present
});
test("collapseContext: folds long unchanged runs, keeps padding", () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 20", "LINE 20");
  const collapsed = collapseContext(lineDiff(before, after), 2);
  assert.ok(collapsed.some((l) => l.kind === "hunk")); // a fold marker exists
  assert.ok(collapsed.length < 40); // shorter than the full file
});

// ---- ThinkFilter (live streaming think-suppression) ----
// exercised indirectly; test the safe-emit boundary logic via a tiny reimpl guard
test("stream think-filter: dims think, shows answer, handles split tags", async () => {
  const { Renderer } = await import("../src/cli/render.js");
  // capture stdout
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    chunks.push(s);
    return true;
  };
  try {
    const r = new Renderer(1000);
    r.thinkingStart();
    // feed "<think>reason</think>answer" split awkwardly across deltas
    r.streamText("<thi");
    r.streamText("nk>reaso");
    r.streamText("n</thi");
    r.streamText("nk>ans");
    r.streamText("wer");
    r.assistant("answer");
    const out = chunks.join("");
    // the visible answer must appear; the think tags themselves must not
    assert.ok(out.includes("answer"));
    assert.ok(!out.includes("<think>"));
    assert.ok(!out.includes("</think>"));
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  }
});

// ---- web_fetch: HTML → text ----
test("htmlToText: strips tags/script/style, decodes entities, keeps text", async () => {
  const { htmlToText } = await import("../src/tools/web-fetch.js");
  const html = `<html><head><style>.a{color:red}</style><script>evil()</script></head>` +
    `<body><h1>Title</h1><p>Hello&nbsp;&amp; welcome</p><p>Line&lt;2&gt;</p></body></html>`;
  const text = htmlToText(html);
  assert.ok(text.includes("Title"));
  assert.ok(text.includes("Hello & welcome"));
  assert.ok(text.includes("Line<2>"));
  assert.ok(!text.includes("evil()")); // script removed
  assert.ok(!text.includes("color:red")); // style removed
  assert.ok(!/<\/?[a-z]/i.test(text)); // no leftover HTML tags
});

// ---- truncation handling + output cap ----
test("loop: surfaces a notice when the response is truncated (done_reason=length)", async () => {
  const provider: Provider = {
    name: "fake",
    async chat() {
      return { content: "partial answer that got cut", toolCalls: [], doneReason: "length", usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
  const notices: string[] = [];
  const ui: LoopUI = {
    onAssistantText() {}, onToolStart() {}, onToolEnd() {}, onNotice: (m) => notices.push(m),
    async askPermission() { return "yes"; },
  };
  const session = new SessionLog(mkdtempSync(join(os.tmpdir(), "omcode-trunc-")));
  const loop = new AgentLoop(
    provider, new ToolRegistry(), { model: "fake", numCtx: 1024, maxToolCallsPerTurn: 3 }, ui, session,
    { cwd: process.cwd() }, "system prompt",
  );
  await loop.runTurn("do it");
  assert.ok(notices.some((n) => /cut off|output limit/i.test(n)));
});
test("config: OMCODE_MAX_OUTPUT parses into settings.maxOutput", async () => {
  const { resolveSettingsFrom } = await import("../src/cli/config.js");
  assert.equal(resolveSettingsFrom({}, { OMCODE_MAX_OUTPUT: "8192" } as NodeJS.ProcessEnv).maxOutput, 8192);
  assert.equal(resolveSettingsFrom({ maxOutput: 4096 }, {} as NodeJS.ProcessEnv).maxOutput, 4096);
  assert.equal(resolveSettingsFrom({}, {} as NodeJS.ProcessEnv).maxOutput, undefined);
});

// ---- multi-language diagnostics ----
test("projectDiagnostics: returns 'none' when no project type is present", async () => {
  const { projectDiagnostics } = await import("../src/tools/diagnostics.js");
  const dir = mkdtempSync(join(os.tmpdir(), "omcode-diag-"));
  writeFileSync(join(dir, "notes.txt"), "hi", "utf8");
  const d = await projectDiagnostics(dir);
  assert.equal(d.language, "none");
  assert.equal(d.failure, undefined);
});
test("projectDiagnostics: detects a TypeScript project via tsconfig.json", async () => {
  const { projectDiagnostics } = await import("../src/tools/diagnostics.js");
  const dir = mkdtempSync(join(os.tmpdir(), "omcode-diag-ts-"));
  writeFileSync(join(dir, "tsconfig.json"), "{}", "utf8"); // empty config → tsc has nothing to fail on
  const d = await projectDiagnostics(dir);
  assert.equal(d.language, "typescript"); // ran the TS path (clean or error, both are "typescript")
});

// ---- model profiles ----
test("profileFor: maps model families and defaults think for qwen3 chat", async () => {
  const { profileFor } = await import("../src/model/profiles.js");
  assert.equal(profileFor("qwen3-coder:480b").family, "qwen-coder");
  assert.equal(profileFor("qwen3-coder:480b").think, undefined); // coder: leave to server
  assert.equal(profileFor("qwen3:8b").family, "qwen");
  assert.equal(profileFor("qwen3:8b").think, false); // thinking model: default off
  assert.equal(profileFor("deepseek-r1:7b").family, "deepseek-r1");
  assert.equal(profileFor("gemma4:31b").family, "gemma");
  assert.ok(profileFor("gemma4:31b").systemAddendum); // weak tooling → reinforced
  assert.equal(profileFor("some-unknown-model").family, "generic");
  assert.equal(profileFor("some-unknown-model").think, undefined);
});
test("buildSystemPrompt: includes the profile addendum", async () => {
  const { buildSystemPrompt } = await import("../src/prompt/system.js");
  const { profileFor } = await import("../src/model/profiles.js");
  const add = profileFor("gemma4:31b").systemAddendum!;
  const prompt = buildSystemPrompt("/tmp", "bash", "editor", add);
  assert.ok(prompt.includes("Note for this model"));
});

// ---- slash commands: /compact /clear /diff /init + project context ----
test("context: compact() force-condenses regardless of budget", async () => {
  const cm = new ContextManager({ numCtx: 999999, reserve: 0, keepRecent: 2 }, async () => "SUMMARY");
  const msgs: ChatMessage[] = [
    { role: "system", content: "sys" },
    ...Array.from({ length: 8 }, (_, i): ChatMessage => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` })),
    { role: "user", content: "LATEST" },
  ];
  const r = await cm.compact(msgs); // way under budget, but /compact forces it
  assert.equal(r.condensed, true);
  assert.match(msgs[1]!.content, /SUMMARY/);
  assert.match(msgs[msgs.length - 1]!.content, /LATEST/);
  assert.ok(r.after <= r.before);
});
test("context: compact() is a no-op with nothing old enough", async () => {
  const cm = new ContextManager({ numCtx: 999999, reserve: 0, keepRecent: 8 }, async () => "S");
  const msgs: ChatMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "hi" }];
  const r = await cm.compact(msgs);
  assert.equal(r.condensed, false);
  assert.equal(msgs.length, 2);
});
test("checkpoint: originals() reports earliest pre-change state per file", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "omcode-orig-"));
  const f = join(dir, "a.txt");
  writeFileSync(f, "v0", "utf8");
  const store = new CheckpointStore();
  store.beginTurn();
  await store.snapshot(f);
  writeFileSync(f, "v1", "utf8");
  store.beginTurn(); // second turn touches the same file — earliest must win
  await store.snapshot(f);
  writeFileSync(f, "v2", "utf8");
  const origs = store.originals();
  assert.equal(origs.length, 1);
  assert.equal(origs[0]!.before, "v0");
});
test("session: loadMessages honors a 'cleared' marker (keeps only system)", () => {
  const dir = mkdtempSync(join(os.tmpdir(), "omcode-clr-"));
  const file = join(dir, "s.jsonl");
  const events = [
    { ts: "t", type: "system", content: "sys" },
    { ts: "t", type: "user", content: "old" },
    { ts: "t", type: "assistant", content: "old-answer" },
    { ts: "t", type: "cleared" },
    { ts: "t", type: "user", content: "fresh" },
  ];
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  const msgs = loadMessages(file);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]!.role, "system");
  assert.equal(msgs[1]!.content, "fresh");
});
test("commands: sessionDiff renders changes and reports when clean", async () => {
  const { sessionDiff, loadProjectContext } = await import("../src/cli/commands.js");
  const dir = mkdtempSync(join(os.tmpdir(), "omcode-cmd-"));
  const f = join(dir, "a.txt");
  writeFileSync(f, "new content\n", "utf8");
  const cp = { originals: () => [{ path: f, before: "old content\n" }] };
  const out = await sessionDiff(cp, dir, false);
  assert.match(out, /a\.txt/);
  assert.match(out, /new content/);
  // no changes → friendly message
  const clean = await sessionDiff({ originals: () => [] }, dir, false);
  assert.match(clean, /no files have been changed/);
  // project context loads AGENTS.md (bounded)
  writeFileSync(join(dir, "AGENTS.md"), "PROJECT-GUIDE", "utf8");
  assert.equal(await loadProjectContext(dir), "PROJECT-GUIDE");
});

// ---- /lint /test ----
test("detectTest: finds an npm test script, else null", async () => {
  const { detectTest } = await import("../src/tools/diagnostics.js");
  const dir = mkdtempSync(join(os.tmpdir(), "omcode-dt-"));
  assert.equal(detectTest(dir), null);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node t.js" } }), "utf8");
  const plan = detectTest(dir);
  assert.ok(plan && plan.label === "npm test");
});
test("commands: lint/test report 'none' outside a recognized project", async () => {
  const { lintProject, testProject } = await import("../src/cli/commands.js");
  const dir = mkdtempSync(join(os.tmpdir(), "omcode-lt-"));
  assert.match(await lintProject(dir), /no recognized project type/);
  assert.match(await testProject(dir), /no test command detected/);
});

void runTests().then(() => {
  console.log(`\n${passed} tests passed${process.exitCode ? " (with failures)" : ""}`);
});
