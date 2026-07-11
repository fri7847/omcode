// Isolated read-only subtask tool.  The parent receives only the final report,
// so exploratory tool output cannot bloat its context (Boomerang pattern).

import { z } from "zod";
import { capOutput, type Tool } from "./registry.js";

const schema = z.object({
  description: z.string().min(1).describe("Focused research or planning subtask for an isolated read-only agent"),
  maxToolCalls: z.number().int().min(1).max(12).optional().describe("Maximum read-only tool calls for the scout (default 8)"),
});

export type TaskRunner = (description: string, maxToolCalls: number) => Promise<string>;

export function makeTaskTool(run: TaskRunner): Tool<z.infer<typeof schema>> {
  return {
    name: "task",
    description:
      "Delegate a focused, read-only repository investigation to an isolated subagent. " +
      "It returns only a compact report; it cannot edit files.",
    schema,
    readOnly: true,
    permission: "ask",
    async execute(input) {
      try {
        return capOutput(await run(input.description, input.maxToolCalls ?? 8), "Ask a narrower task or inspect a named file directly.");
      } catch (err) {
        return `Isolated subtask failed: ${(err as Error).message}. Continue with direct read/glob/grep instead.`;
      }
    },
  };
}
