/**
 * OMcode permission modes, enforced by the harness (not trusted to a model
 * instruction):
 *   read — read-only. Mutating tools are blocked; investigate and plan.
 *   ask  — default. Mutations run through the normal per-tool approval.
 *   auto — mutations are applied automatically (no approval prompt).
 * Orthogonal to per-tool /permissions overrides.
 */
export type AgentMode = "read" | "ask" | "auto";

export function parseAgentMode(value: string | undefined): AgentMode | undefined {
  switch (value) {
    case "read":
    case "ask":
    case "auto":
      return value;
    // legacy values (older configs / env) map onto the current modes
    case "scout":
    case "architect":
      return "read";
    case "check":
    case "editor":
      return "ask";
    case "flow":
      return "auto";
    default:
      return undefined;
  }
}

/** read mode blocks every mutating (non-read-only) tool. */
export function blocksTool(mode: AgentMode, readOnly: boolean): boolean {
  return mode === "read" && !readOnly;
}

/** auto mode skips the approval prompt for tools that would otherwise ask. */
export function autoAccepts(mode: AgentMode): boolean {
  return mode === "auto";
}
