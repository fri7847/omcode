/**
 * OMcode permission modes, enforced by the harness (not trusted to a model
 * instruction). Named for how much the harness gates changes:
 *   scout — read-only. Mutating tools are blocked; investigate and plan.
 *   check — default. Mutations run through the normal per-tool approval.
 *   flow  — mutations are applied automatically (no approval prompt).
 * Orthogonal to per-tool /permissions overrides.
 */
export type AgentMode = "scout" | "check" | "flow";

export function parseAgentMode(value: string | undefined): AgentMode | undefined {
  switch (value) {
    case "scout":
    case "check":
    case "flow":
      return value;
    // legacy values (older configs / env) map onto the current modes
    case "architect":
      return "scout";
    case "editor":
      return "check";
    default:
      return undefined;
  }
}

/** scout mode blocks every mutating (non-read-only) tool. */
export function blocksTool(mode: AgentMode, readOnly: boolean): boolean {
  return mode === "scout" && !readOnly;
}

/** flow mode skips the approval prompt for tools that would otherwise ask. */
export function autoAccepts(mode: AgentMode): boolean {
  return mode === "flow";
}
