// Cheap post-edit feedback for TypeScript projects.  This is intentionally a
// deterministic compiler check rather than another model turn; the editor can
// read the exact diagnostics and correct them on its next request.

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { capOutput, type Tool } from "./registry.js";

const schema = z.object({});
const TIMEOUT_MS = 60_000;

export function typecheckCommand(cwd: string, node = process.execPath): { command: string; args: string[] } {
  return {
    // Calling Node directly avoids Windows' .cmd + shell:false incompatibility
    // while still avoiding a shell entirely on every platform.
    command: node,
    args: [join(cwd, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--pretty", "false"],
  };
}

/** Undefined means either no TypeScript project or a clean check. */
export async function typecheckFailure(cwd: string): Promise<string | undefined> {
  if (!existsSync(join(cwd, "tsconfig.json"))) return undefined;
  const { command, args } = typecheckCommand(cwd);
  try {
    const result = await run(command, args, cwd);
    if (result.code === 0) return undefined;
    return capOutput(
      `TypeScript diagnostics failed (exit ${result.code}):\n${result.output || "No compiler output."}`,
      "Fix the reported files and run typecheck again.",
    );
  } catch (err) {
    return `Could not run local TypeScript diagnostics: ${(err as Error).message}. Install dependencies, then try again.`;
  }
}

function run(command: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let output = "";
    const add = (chunk: Buffer) => { output += chunk.toString("utf8"); };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, output }); });
  });
}

export const typecheckTool: Tool<z.infer<typeof schema>> = {
  name: "typecheck",
  description:
    "Run the local TypeScript compiler without emitting files. Use after TypeScript edits to see exact diagnostics.",
  schema,
  readOnly: true,
  permission: "ask",
  async execute(_input, ctx) {
    if (!existsSync(join(ctx.cwd, "tsconfig.json"))) {
      return "No tsconfig.json found, so TypeScript diagnostics are unavailable. Use an appropriate project test command instead.";
    }
    return (await typecheckFailure(ctx.cwd)) ?? "TypeScript diagnostics passed (tsc --noEmit).";
  },
};
