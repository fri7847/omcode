// Shell tool. No persistent session in Phase 0 (simplicity first).
// Hard timeout — bash hangs with no timeout are a documented Gemini CLI
// complaint. Output cap per registry policy.

import { execFile } from "node:child_process";
import { z } from "zod";
import { capOutput, type Tool, type ToolPreview } from "./registry.js";

const schema = z.object({
  command: z.string().describe("The shell command to run"),
  timeoutSec: z
    .number()
    .int()
    .min(1)
    .max(600)
    .optional()
    .describe("Timeout in seconds (default 120)"),
});

export interface ShellRuntime {
  file: string;
  args: (command: string) => string[];
  label: string;
}

export function detectShell(): ShellRuntime {
  if (process.platform === "win32") {
    // PowerShell is always present on Windows; keep it predictable.
    return {
      file: "powershell.exe",
      args: (cmd) => ["-NoProfile", "-NonInteractive", "-Command", cmd],
      label: "PowerShell",
    };
  }
  return { file: "/bin/bash", args: (cmd) => ["-c", cmd], label: "bash" };
}

export function makeShellTool(runtime: ShellRuntime): Tool<z.infer<typeof schema>> {
  return {
    name: "shell",
    description:
      `Run a ${runtime.label} command in the working directory and return its output. ` +
      `Commands time out (default 120s). Do not run interactive commands or long-running servers.`,
    schema,
    readOnly: false,
    permission: "ask",
    async preview(input): Promise<ToolPreview | null> {
      return { kind: "command", text: input.command };
    },
    execute(input, ctx) {
      const timeout = (input.timeoutSec ?? 120) * 1000;
      return new Promise((resolvePromise) => {
        execFile(
          runtime.file,
          runtime.args(input.command),
          { cwd: ctx.cwd, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
          (err, stdout, stderr) => {
            const parts: string[] = [];
            if (stdout) parts.push(stdout.trimEnd());
            if (stderr) parts.push(`[stderr]\n${stderr.trimEnd()}`);
            if (err) {
              const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
              if (killed) {
                parts.push(
                  `[command timed out after ${timeout / 1000}s and was killed. ` +
                    `If it needs longer, retry with a larger timeoutSec; if it is a server/watch process, do not run it here.]`,
                );
              } else {
                const code = (err as { code?: number | string }).code;
                parts.push(`[exit ${code ?? "error"}: ${err.message.split("\n")[0]}]`);
              }
            } else {
              parts.push(`[exit 0]`);
            }
            resolvePromise(
              capOutput(parts.join("\n"), "Pipe through a filter (findstr/Select-String, head) to reduce output."),
            );
          },
        );
      });
    },
  };
}
