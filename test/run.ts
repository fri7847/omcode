// Phase 0 harness tests — everything that must work WITHOUT a model.
// The io-guard and loop-breaker are the parts that absorb model mistakes;
// they must be provably correct before we blame any model.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
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

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err);
    process.exitCode = 1;
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

console.log(`\n${passed} tests passed${process.exitCode ? " (with failures)" : ""}`);
