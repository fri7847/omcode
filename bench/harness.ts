// Harness performance scorecard — QUANTIFIES the harness itself, no model.
//
// OMcode's thesis is "absorb the model's mistakes with the fewest possible
// tokens." That is a property of the harness code, not the model, so it can be
// measured deterministically: feed each defense layer the exact kind of mistake
// a weak model makes and check whether the harness catches it — and whether it
// does so at ZERO extra tokens (harness code) vs. needing a model retry.
//
// Run:  npx tsx bench/harness.ts

import { guard } from "../src/model/io-guard.js";
import { applyEdit, type MatchMethod } from "../src/tools/applier.js";
import { LoopBreaker } from "../src/policy/loop-breaker.js";
import type { ChatResult, ToolCall } from "../src/model/provider.js";

const R = "\x1b[0m", B = "\x1b[1m", G = "\x1b[32m", Y = "\x1b[33m", RED = "\x1b[31m", D = "\x1b[2m";

function res(content: string, toolCalls: ToolCall[] = []): ChatResult {
  return { content, toolCalls, doneReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } };
}
const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: "x", name, arguments: args });

interface Case {
  name: string;
  pass: boolean;
  /** true = the harness fixed the mistake in code, no model retry needed */
  absorbed: boolean;
}

// ---- io-guard: does it recover/classify the model's I/O mistakes? ----
function ioGuard(): Case[] {
  const c: Case[] = [];
  const add = (name: string, pass: boolean, absorbed = pass) => c.push({ name, pass, absorbed });

  const nativeCall = guard(res("", [call("read", { path: "a" })]));
  add("native tool call passes through", nativeCall.kind === "tool-calls" && nativeCall.toolCallSource === "native", false);

  const xml = guard(res(`<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>`));
  add("recovers Hermes <tool_call> XML", xml.toolCallSource === "recovered-xml" && xml.toolCalls[0]?.name === "read");

  const fenced = guard(res("```json\n{\"name\":\"glob\",\"arguments\":{\"pattern\":\"*.ts\"}}\n```"));
  add("recovers fenced JSON call", fenced.toolCallSource === "recovered-json" && fenced.toolCalls[0]?.name === "glob");

  const bare = guard(res(`{"name":"grep","arguments":{"pattern":"foo"}}`));
  add("recovers bare JSON call", bare.toolCallSource === "recovered-json" && bare.toolCalls[0]?.name === "grep");

  const think = guard(res("<think>let me reason</think>Here is the answer."));
  add("strips <think> leakage", !think.content.includes("<think>") && think.content.includes("answer"));

  const prose = guard(res('You could call {"name": "x"} but I need more info.'));
  add("does NOT eat ordinary JSON in prose", prose.kind === "text" && prose.toolCalls.length === 0, false);

  const empty = guard(res(""));
  add("classifies empty as end-turn (not error)", empty.kind === "empty-end-turn", false);

  const degen = guard(res("0".repeat(200)));
  add("detects degenerate output", degen.kind === "degenerate", false);

  return c;
}

// ---- applier: does the fuzzy SEARCH/REPLACE absorb the model's edit mistakes? ----
function applier(): Case[] {
  const c: Case[] = [];
  const file = "function add(a, b) {\n  return a + b;\n}\n\nfunction sub(a, b) {\n  return a - b;\n}\n";
  const add = (name: string, ok: boolean, method?: MatchMethod, absorbed = ok) =>
    c.push({ name: method ? `${name} [${method}]` : name, pass: ok, absorbed });

  const exact = applyEdit({ content: file, search: "  return a + b;", replace: "  return a + b; // sum" });
  add("exact match", exact.ok, exact.ok ? exact.method : undefined, false); // exact = model got it right

  const ws = applyEdit({ content: file, search: "  return a + b;   ", replace: "  return a + b; // x" });
  add("trailing-whitespace mismatch", ws.ok, ws.ok ? ws.method : undefined);

  const tabs = applyEdit({ content: file, search: "\treturn a + b;", replace: "  return a + b; // t" });
  add("tab-vs-space mismatch", tabs.ok, tabs.ok ? tabs.method : undefined);

  const fuzzy = applyEdit({ content: file, search: "function add(a,b) {", replace: "function ADD(a, b) {" });
  add("fuzzy near-match (1-char typo, ≥90%)", fuzzy.ok, fuzzy.ok ? fuzzy.method : undefined);

  const dup = applyEdit({ content: "x = 1;\ny = 2;\nx = 1;\n", search: "x = 1;", replace: "x = 9;", startLine: 3 });
  add("duplicate block resolved by startLine", dup.ok && dup.content.endsWith("x = 9;\n"));

  const miss = applyEdit({ content: file, search: "totally unrelated line here", replace: "x" });
  add("unmatched fails WITH a self-correction guide", !miss.ok && miss.error.length > 40, undefined, false);

  return c;
}

// ---- loop-breaker: does it actually intervene on repeated calls? ----
function loopBreaker(): Case[] {
  const c: Case[] = [];
  const b = new LoopBreaker();
  const same = call("read", { path: "a" });
  const v1 = b.check(same);
  const v2 = b.check(same);
  const v3 = b.check(same);
  c.push({ name: "1st call proceeds", pass: v1.action === "proceed", absorbed: false });
  c.push({ name: "2nd identical call → nudge", pass: v2.action === "nudge", absorbed: true });
  c.push({ name: "3rd identical call → halt", pass: v3.action === "halt", absorbed: true });

  const b2 = new LoopBreaker();
  b2.check(call("read", { path: "a" }));
  const diff = b2.check(call("read", { path: "b" }));
  c.push({ name: "different args → no false intervention", pass: diff.action === "proceed", absorbed: false });

  return c;
}

function section(title: string, cases: Case[]): { pass: number; total: number; absorbed: number; absorbable: number } {
  const pass = cases.filter((x) => x.pass).length;
  const absorbable = cases.filter((x) => x.absorbed).length;
  const absorbed = cases.filter((x) => x.absorbed && x.pass).length;
  const pct = Math.round((pass / cases.length) * 100);
  const color = pct === 100 ? G : pct >= 80 ? Y : RED;
  console.log(`\n${B}${title}${R}  ${color}${pass}/${cases.length} (${pct}%)${R}`);
  for (const x of cases) {
    const mark = x.pass ? `${G}✓${R}` : `${RED}✗${R}`;
    console.log(`  ${mark} ${x.pass ? D : RED}${x.name}${R}`);
  }
  return { pass, total: cases.length, absorbed, absorbable };
}

function timeit(label: string, fn: () => void, iters = 20000): void {
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const per = ((performance.now() - t0) / iters).toFixed(4);
  console.log(`  ${label}  ${per} ms/op`);
}

function main(): void {
  console.log(`${B}OMcode harness scorecard${R} ${D}— deterministic, no model${R}`);

  const io = section("io-guard  (model I/O recovery)", ioGuard());
  const ap = section("applier   (fuzzy edit absorption)", applier());
  const lb = section("loop-breaker (loop intervention)", loopBreaker());

  const pass = io.pass + ap.pass + lb.pass;
  const total = io.total + ap.total + lb.total;
  const absorbed = io.absorbed + ap.absorbed + lb.absorbed;
  const absorbable = io.absorbable + ap.absorbable + lb.absorbable;

  console.log(`\n${B}Overhead${R} ${D}(cost of the defenses themselves)${R}`);
  const file = "a = 1;\nb = 2;\nc = 3;\n";
  timeit("guard()   ", () => guard(res(`<tool_call>{"name":"read","arguments":{}}</tool_call>`)));
  timeit("applyEdit()", () => applyEdit({ content: file, search: "b = 2;", replace: "b = 9;" }));

  const score = Math.round((pass / total) * 100);
  const absPct = Math.round((absorbed / absorbable) * 100);
  const c = score === 100 ? G : score >= 80 ? Y : RED;
  console.log(
    `\n${B}Thesis metric${R} — mistakes absorbed at ${B}0 extra tokens${R}: ${G}${absorbed}/${absorbable} (${absPct}%)${R}`,
  );
  console.log(`${B}SCORE ${c}${pass}/${total} (${score}%)${R}\n`);
  if (pass !== total) process.exitCode = 1;
}

main();
