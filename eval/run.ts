// Mini benchmark runner — aider-style 2-attempt protocol.
// Reports the four first-class metrics (DESIGN.md §7):
//   pass@1 / pass@2 · edit-apply rate · recovered tool calls · tokens per passed task
// Usage: tsx eval/run.ts [model]

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import os from "node:os";
import { AgentLoop, type LoopUI } from "../src/core/loop.js";
import { SessionLog } from "../src/core/session.js";
import { OllamaProvider } from "../src/model/ollama.js";
import { buildSystemPrompt } from "../src/prompt/system.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { readTool } from "../src/tools/read.js";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";
import { makeEditTool, newEditStats, type EditStats } from "../src/tools/edit.js";
import { writeTool } from "../src/tools/write.js";
import { tasks } from "./tasks.js";

const model = process.argv[2] ?? process.env["OMCODE_MODEL"] ?? "qwen3:8b";
const numCtx = Number(process.env["OMCODE_NUM_CTX"] ?? 16_384);
const think =
  process.env["OMCODE_THINK"] === "true" ? true : process.env["OMCODE_THINK"] === "false" ? false : false;

interface Row {
  task: string;
  pass1: boolean;
  pass2: boolean;
  edits: EditStats;
  recovered: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  seconds: number;
  detail: string;
}

const verbose = process.env["OMCODE_EVAL_VERBOSE"] === "1";
const quietUI: LoopUI = {
  onAssistantText: (t) => {
    if (verbose) process.stdout.write(`    [assistant] ${t.slice(0, 400)}\n`);
  },
  onToolStart: (c) =>
    process.stdout.write(`    ⚙ ${c.name} ${JSON.stringify(c.arguments).slice(0, 100)}\n`),
  onToolEnd: (c, r) => {
    if (verbose) process.stdout.write(`    [result] ${r.slice(0, 300).replace(/\n/g, " ⏎ ")}\n`);
  },
  onNotice: (m) => process.stdout.write(`    ! ${m}\n`),
  askPermission: async () => "yes" as const, // sandboxed temp dir — auto-allow
};

async function runTask(taskIndex: number): Promise<Row> {
  const task = tasks[taskIndex]!;
  const dir = join(os.tmpdir(), "omcode-eval", `${Date.now()}-${task.name}`);
  await mkdir(dir, { recursive: true });
  for (const [rel, body] of Object.entries(task.files)) {
    const p = join(dir, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body, "utf8");
  }

  const provider = new OllamaProvider({
    host: process.env["OMCODE_HOST"] ?? "http://localhost:11434",
    apiKey: process.env["OLLAMA_API_KEY"],
    timeoutMs: 180_000,
  });
  const registry = new ToolRegistry();
  const edits = newEditStats();
  registry.register(readTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(makeEditTool(edits));
  registry.register(writeTool);
  // no shell in the benchmark — file tools only

  const loop = new AgentLoop(
    provider,
    registry,
    { model, numCtx, maxToolCallsPerTurn: 15, think },
    quietUI,
    new SessionLog(join(os.tmpdir(), "omcode-eval", "sessions")),
    { cwd: dir },
    buildSystemPrompt(dir, "none"),
  );

  const t0 = Date.now();
  let requests = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let recovered = 0;

  const s1 = await loop.runTurn(task.prompt);
  requests += s1.requests;
  promptTokens += s1.promptTokens;
  completionTokens += s1.completionTokens;
  recovered += s1.recoveredCalls;

  let { pass, detail } = await task.check(dir);
  const pass1 = pass;

  if (!pass) {
    // attempt 2: show the model the real failure (aider protocol)
    const s2 = await loop.runTurn(
      `Verification failed: ${detail}. Re-read the file(s), fix the problem, and make sure the requested change is fully applied.`,
    );
    requests += s2.requests;
    promptTokens += s2.promptTokens;
    completionTokens += s2.completionTokens;
    recovered += s2.recoveredCalls;
    ({ pass, detail } = await task.check(dir));
  }

  await rm(dir, { recursive: true, force: true }).catch(() => {});
  return {
    task: task.name,
    pass1,
    pass2: pass,
    edits,
    recovered,
    requests,
    promptTokens,
    completionTokens,
    seconds: (Date.now() - t0) / 1000,
    detail: pass ? "ok" : detail,
  };
}

const filter = process.argv[3];
const selected = filter ? tasks.map((t, i) => [t, i] as const).filter(([t]) => t.name.includes(filter)) : tasks.map((t, i) => [t, i] as const);

console.log(`omcode mini-bench · model=${model} · num_ctx=${numCtx} · think=${think}\n`);
const rows: Row[] = [];
for (let k = 0; k < selected.length; k++) {
  const [task, i] = selected[k]!;
  process.stdout.write(`[${k + 1}/${selected.length}] ${task.name}\n`);
  try {
    const row = await runTask(i);
    rows.push(row);
    process.stdout.write(
      `    → ${row.pass2 ? (row.pass1 ? "PASS@1" : "PASS@2") : "FAIL"} · edits ${row.edits.applied}/${row.edits.attempts} · ${row.seconds.toFixed(0)}s · ${row.promptTokens}↑${row.completionTokens}↓${row.pass2 ? "" : ` · ${row.detail}`}\n`,
    );
  } catch (err) {
    process.stdout.write(`    → ERROR ${(err as Error).message}\n`);
    rows.push({
      task: task.name, pass1: false, pass2: false, edits: newEditStats(), recovered: 0,
      requests: 0, promptTokens: 0, completionTokens: 0, seconds: 0,
      detail: (err as Error).message,
    });
  }
}

const passed1 = rows.filter((r) => r.pass1).length;
const passed2 = rows.filter((r) => r.pass2).length;
const editAttempts = rows.reduce((n, r) => n + r.edits.attempts, 0);
const editApplied = rows.reduce((n, r) => n + r.edits.applied, 0);
const byMethod = rows.reduce(
  (acc, r) => ({
    exact: acc.exact + r.edits.byMethod.exact,
    normalized: acc.normalized + r.edits.byMethod.normalized,
    fuzzy: acc.fuzzy + r.edits.byMethod.fuzzy,
  }),
  { exact: 0, normalized: 0, fuzzy: 0 },
);
const totalTokens = rows.reduce((n, r) => n + r.promptTokens + r.completionTokens, 0);
const passedTokens = rows.filter((r) => r.pass2).reduce((n, r) => n + r.promptTokens + r.completionTokens, 0);
const recoveredTotal = rows.reduce((n, r) => n + r.recovered, 0);

console.log(`\n══════ RESULTS ══════`);
console.log(`pass@1          ${passed1}/${rows.length} (${pct(passed1, rows.length)})`);
console.log(`pass@2          ${passed2}/${rows.length} (${pct(passed2, rows.length)})`);
console.log(
  `edit-apply rate ${editApplied}/${editAttempts} (${pct(editApplied, editAttempts)}) · exact ${byMethod.exact} / normalized ${byMethod.normalized} / fuzzy ${byMethod.fuzzy}`,
);
console.log(`recovered calls ${recoveredTotal}`);
console.log(`tokens total    ${totalTokens} · per passed task ${passed2 ? Math.round(passedTokens / passed2) : "—"}`);

function pct(a: number, b: number): string {
  return b === 0 ? "—" : `${Math.round((a / b) * 100)}%`;
}
