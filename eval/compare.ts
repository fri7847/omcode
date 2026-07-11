// Cross-harness benchmark. Holds the MODEL constant (local Ollama) and varies
// the HARNESS, running the same edit tasks (eval/tasks.ts) through each as a
// black box, then scoring with the task's own deterministic check(). This is
// how you rank harnesses fairly: same model, same tasks, same grader.
//
// Run:  AIDER_PY=<python-with-aider> npx tsx eval/compare.ts [--model qwen3:8b] [--tasks 3] [--only omcode,aider]
//
// Requires a local Ollama with the model pulled. Competitors are optional —
// a harness that isn't installed is skipped (reported n/a), never fatal.
//   - aider: set AIDER_PY to a python.exe that has `aider-chat` installed.
//   - codex: needs `codex` on PATH; codex v0.141's --oss path expects Ollama's
//     native /api/tags shape and currently mis-reads the /v1/models response,
//     so it may not drive a local model cleanly (excluded in that case).

import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { tasks, type EvalTask } from "./tasks.js";

const arg = (flag: string, def: string): string => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};

const MODEL = arg("--model", "qwen3:8b");
const OLLAMA = arg("--host", "http://localhost:11434");
let API_KEY = process.env["OLLAMA_API_KEY"] ?? "";
const TASK_LIMIT = Number(arg("--tasks", String(tasks.length)));
const ONLY = arg("--only", "").split(",").filter(Boolean);
const PER_TASK_TIMEOUT = 300_000; // local models are slow
const OMCODE_REPL = join(dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..", "src", "cli", "repl.ts");

interface RunResult { code: number; out: string; ms: number; timedOut: boolean; }

/** Best-effort token total parsed from a harness's own output (0 if unknown). */
function parseTokens(harness: string, out: string): number {
  if (harness === "aider") {
    // "Tokens: 701 sent, 53 received." (may repeat per message — sum them)
    let total = 0;
    for (const m of out.matchAll(/Tokens:\s*([\d,]+)\s*sent,\s*([\d,]+)\s*received/g)) {
      total += Number(m[1]!.replace(/,/g, "")) + Number(m[2]!.replace(/,/g, ""));
    }
    return total;
  }
  if (harness === "omcode") {
    // OMcode's turn footer prints a cumulative "session <n|n.nk>"; take the last.
    const all = [...out.matchAll(/session\s+([\d.]+)(k?)/g)];
    const last = all[all.length - 1];
    if (!last) return 0;
    return Math.round(Number(last[1]) * (last[2] === "k" ? 1000 : 1));
  }
  return 0;
}

function spawnCollect(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; input?: string; shell?: boolean },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, shell: opts.shell ?? false, windowsHide: true });
    } catch (err) {
      resolve({ code: 1, out: `spawn failed: ${(err as Error).message}`, ms: 0, timedOut: false });
      return;
    }
    let out = "";
    const add = (b: Buffer) => { out += b.toString("utf8"); };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, PER_TASK_TIMEOUT);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 1, out: out + `\n[error] ${e.message}`, ms: Date.now() - t0, timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out, ms: Date.now() - t0, timedOut }); });
    if (opts.input !== undefined) { child.stdin?.write(opts.input); child.stdin?.end(); }
  });
}

interface Adapter {
  name: string;
  available: () => Promise<boolean>;
  run: (dir: string, promptFile: string, prompt: string, files: string[]) => Promise<RunResult>;
}

const win = process.platform === "win32";
const AIDER_PY = process.env["AIDER_PY"] ?? ""; // path to a python.exe with aider installed
const npx = win ? "npx.cmd" : "npx";

const adapters: Adapter[] = [
  {
    name: "omcode",
    available: async () => true,
    run: (dir, _pf, prompt) =>
      spawnCollect(npx, ["tsx", OMCODE_REPL], {
        cwd: dir,
        shell: win, // npx.cmd needs a shell on Windows
        env: { OMCODE_MODE: "auto", OMCODE_MODEL: MODEL, OMCODE_HOST: OLLAMA, OMCODE_STREAM: "false", OMCODE_NUM_CTX: "16384", OLLAMA_API_KEY: API_KEY },
        input: `${prompt}\n/exit\n`,
      }),
  },
  {
    name: "aider",
    available: async () => Boolean(AIDER_PY),
    run: (dir, promptFile, _p, files) =>
      spawnCollect(AIDER_PY, ["-m", "aider", "--model", `ollama_chat/${MODEL}`, "--yes-always", "--no-git", "--no-auto-commits", "--no-check-update", "--no-show-model-warnings", "--no-pretty", "--no-stream", "--map-tokens", "0", "--message-file", promptFile, ...files], {
        cwd: dir,
        // PYTHONUTF8 avoids a cp949/rich UnicodeEncodeError crash on Windows consoles
        env: { OLLAMA_API_BASE: OLLAMA, OLLAMA_API_KEY: API_KEY, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      }),
  },
  {
    name: "codex",
    available: async () => (await spawnCollect(win ? "codex.cmd" : "codex", ["--version"], { cwd: process.cwd(), shell: win })).code === 0,
    run: (dir, _pf, prompt) =>
      spawnCollect(win ? "codex.cmd" : "codex", ["exec", "--oss", "-c", "oss_provider=ollama", "-m", MODEL, "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"], {
        cwd: dir,
        shell: win,
        input: prompt, // codex exec reads instructions from stdin when no prompt arg
      }),
  },
];

async function setupDir(task: EvalTask): Promise<{ dir: string; files: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), `bench-${task.name}-`));
  const files = Object.keys(task.files);
  for (const [rel, body] of Object.entries(task.files)) {
    const p = join(dir, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body, "utf8");
  }
  await writeFile(join(dir, ".prompt.txt"), task.prompt, "utf8");
  return { dir, files };
}

interface Score { pass: number; total: number; ms: number; tokens: number; ran: boolean; }

async function loadKey(): Promise<void> {
  if (API_KEY || !OLLAMA.includes("ollama.com")) return;
  try {
    const cfg = JSON.parse(await readFile(join(homedir(), ".omcode", "config.json"), "utf8")) as { apiKey?: string };
    API_KEY = cfg.apiKey ?? "";
  } catch {
    /* no config — cloud calls will fail loudly, which is fine */
  }
}

async function main(): Promise<void> {
  await loadKey();
  const use = adapters.filter((a) => ONLY.length === 0 || ONLY.includes(a.name));
  const active: Adapter[] = [];
  for (const a of use) if (await a.available()) active.push(a); else console.log(`  ${a.name}: not available (skipped)`);

  const battery = tasks.slice(0, TASK_LIMIT);
  console.log(`\nmodel: ${MODEL}  ·  tasks: ${battery.length}  ·  harnesses: ${active.map((a) => a.name).join(", ")}\n`);

  const scores: Record<string, Score> = {};
  for (const a of active) scores[a.name] = { pass: 0, total: 0, ms: 0, tokens: 0, ran: true };

  for (const task of battery) {
    process.stdout.write(`■ ${task.name}\n`);
    for (const a of active) {
      const { dir, files } = await setupDir(task);
      const r = await a.run(dir, join(dir, ".prompt.txt"), task.prompt, files);
      const check = await task.check(dir).catch((e) => ({ pass: false, detail: String(e) }));
      const tok = parseTokens(a.name, r.out);
      const s = scores[a.name]!;
      s.total++; s.ms += r.ms; s.tokens += tok; if (check.pass) s.pass++;
      const mark = check.pass ? "PASS" : r.timedOut ? "TIMEOUT" : "fail";
      process.stdout.write(`    ${a.name.padEnd(8)} ${mark.padEnd(8)} ${(r.ms / 1000).toFixed(0)}s  ${tok ? tok + "tok  " : ""}${check.pass ? "" : "· " + check.detail.slice(0, 55)}\n`);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  console.log(`\n${"harness".padEnd(10)} ${"pass".padEnd(8)} ${"pass%".padEnd(7)} ${"avg-time".padEnd(9)} tok/success`);
  const ranking = active
    .map((a) => scores[a.name]!)
    .map((s, i) => ({
      name: active[i]!.name,
      ...s,
      pct: s.total ? Math.round((s.pass / s.total) * 100) : 0,
      avg: s.total ? s.ms / s.total / 1000 : 0,
      tokPer: s.pass ? Math.round(s.tokens / s.pass) : 0,
    }))
    .sort((x, y) => y.pct - x.pct || x.avg - y.avg);
  ranking.forEach((r, i) => {
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "  ";
    console.log(`${medal} ${r.name.padEnd(8)} ${`${r.pass}/${r.total}`.padEnd(8)} ${`${r.pct}%`.padEnd(7)} ${`${r.avg.toFixed(0)}s`.padEnd(9)} ${r.tokPer ? r.tokPer.toLocaleString() : "n/a"}`);
  });
  console.log();
}

void main();
