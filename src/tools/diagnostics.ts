// Deterministic post-edit diagnostics for the project's language. Generalizes
// the TypeScript-only check: detect the toolchain, run the appropriate
// non-emitting checker, and feed exact errors back to the editor. Each language
// is gated on its tool being installed — a missing toolchain is silently
// skipped (returns undefined), never an error.

import { existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { capOutput, type Tool } from "./registry.js";
import { typecheckFailure } from "./typecheck.js";

const TIMEOUT_MS = 60_000;

interface RunResult {
  code: number;
  output: string;
  /** the command binary was not found (toolchain not installed) */
  missing: boolean;
}

function run(command: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let output = "";
    const add = (chunk: Buffer) => { output += chunk.toString("utf8"); };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: 1, output: err.message, missing: err.code === "ENOENT" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output, missing: false });
    });
  });
}

function hasPython(cwd: string): boolean {
  if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py")) || existsSync(join(cwd, "requirements.txt"))) {
    return true;
  }
  try {
    return readdirSync(cwd).some((f) => f.endsWith(".py"));
  } catch {
    return false;
  }
}

export interface Diagnostics {
  language: string;
  /** undefined = clean or no toolchain; string = the failure to report */
  failure?: string;
}

/**
 * Detect the project language and run its non-emitting checker.
 * Returns the language it ran (or "none") and any failure to surface.
 */
export async function projectDiagnostics(cwd: string): Promise<Diagnostics> {
  // TypeScript — reuse the existing tsc path.
  if (existsSync(join(cwd, "tsconfig.json"))) {
    return { language: "typescript", failure: await typecheckFailure(cwd) };
  }
  // Go — `go vet` also surfaces compile errors.
  if (existsSync(join(cwd, "go.mod"))) {
    const r = await run("go", ["vet", "./..."], cwd);
    if (r.missing) return { language: "go", failure: undefined };
    if (r.code === 0) return { language: "go" };
    return { language: "go", failure: capOutput(`go vet failed (exit ${r.code}):\n${r.output || "no output"}`, "Fix the reported files and re-check.") };
  }
  // Python — ruff if available (fast, common); skip silently otherwise.
  if (hasPython(cwd)) {
    const r = await run("ruff", ["check", "."], cwd);
    if (r.missing) return { language: "python", failure: undefined };
    if (r.code === 0) return { language: "python" };
    return { language: "python", failure: capOutput(`ruff found issues (exit ${r.code}):\n${r.output || "no output"}`, "Fix the reported lines and re-check.") };
  }
  return { language: "none" };
}

/** Post-edit hook shape: return the failure string, or undefined when clean. */
export async function postEditDiagnostics(cwd: string): Promise<string | undefined> {
  return (await projectDiagnostics(cwd)).failure;
}

const schema = z.object({});

export const diagnosticsTool: Tool<z.infer<typeof schema>> = {
  name: "diagnostics",
  description:
    "Run the project's language checker without emitting files (TypeScript: tsc; Go: go vet; Python: ruff). " +
    "Use after edits to see exact, deterministic diagnostics.",
  schema,
  readOnly: true,
  permission: "ask",
  async execute(_input, ctx) {
    const { language, failure } = await projectDiagnostics(ctx.cwd);
    if (language === "none") {
      return "No recognized project type (tsconfig.json / go.mod / Python) was found. Use an appropriate project test command instead.";
    }
    return failure ?? `${language} diagnostics passed (no issues).`;
  },
};
