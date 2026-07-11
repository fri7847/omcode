/**
 * Architect/editor separation is enforced by the harness, not trusted to a
 * model instruction.  That lets a reasoning-heavy model inspect and plan
 * safely before an editor model is allowed to mutate the workspace.
 */
export type AgentMode = "architect" | "editor";

export function parseAgentMode(value: string | undefined): AgentMode | undefined {
  return value === "architect" || value === "editor" ? value : undefined;
}

export function blocksTool(mode: AgentMode, readOnly: boolean): boolean {
  return mode === "architect" && !readOnly;
}
