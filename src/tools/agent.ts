// run_agent — lets the model delegate to a user-defined sub-agent, either
// because the user asked for it by name or because the agent's description fits
// the work. Each agent runs in an isolated, read-only context (like task) and
// returns a compact report. Only registered when at least one agent exists, so
// it adds no tool-schema overhead to projects that define none.

import { z } from "zod";
import { capOutput, type Tool } from "./registry.js";
import type { AgentDef } from "../core/agents.js";

const schema = z.object({
  agent: z.string().min(1).describe("Name of the sub-agent to run (see the list in this tool's description)"),
  task: z.string().min(1).describe("The concrete task or question to hand the sub-agent"),
});

export type AgentRunner = (def: AgentDef, task: string) => Promise<string>;

export function makeAgentTool(agents: AgentDef[], run: AgentRunner): Tool<z.infer<typeof schema>> {
  const list = agents.map((a) => `- ${a.name}: ${a.description}`).join("\n");
  return {
    name: "run_agent",
    description:
      "Delegate a task to a specialized, user-defined sub-agent when its description fits the work — " +
      "whether the user named it or you judged it appropriate. Each runs in an isolated read-only " +
      "context and returns a concise report; it cannot edit files.\nAvailable agents:\n" + list,
    schema,
    readOnly: true,
    permission: "allow",
    async execute(input) {
      const def = agents.find((a) => a.name.toLowerCase() === input.agent.toLowerCase());
      if (!def) {
        return `Unknown agent "${input.agent}". Available: ${agents.map((a) => a.name).join(", ") || "(none)"}.`;
      }
      try {
        return capOutput(await run(def, input.task), "Hand the agent a narrower task.");
      } catch (err) {
        return `Agent "${def.name}" failed: ${(err as Error).message}. Continue directly instead.`;
      }
    },
  };
}
