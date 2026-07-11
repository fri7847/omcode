// Uniform tool interface (Claude Code lesson): schema validation + permission
// + concurrency flag in one shape, so tools can be added without touching the
// loop. Output is capped — oversized tool results parked in history and
// re-sent every turn are the quadratic-cost driver (OpenHands lesson).

import { z } from "zod";
import type { ToolSchema } from "../model/provider.js";

export type Permission = "allow" | "ask" | "deny";

export interface ToolContext {
  cwd: string;
  /** optional per-turn file snapshots for /undo */
  checkpoints?: {
    snapshot(absPath: string): Promise<void>;
  };
  /** report an applied file change so the UI can tally +N/-M for the session */
  onFileChange?(added: number, removed: number): void;
  /**
   * Optional deterministic post-edit check. It returns text only for a real
   * failure, so successful edits add no diagnostic tokens to model context.
   */
  postEditDiagnostics?(): Promise<string | undefined>;
}

/** What a tool proposes to do — shown in the approval dialog before it runs. */
export type ToolPreview =
  | { kind: "diff"; path: string; before: string; after: string }
  | { kind: "command"; text: string };

export interface Tool<I = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<I>;
  readOnly: boolean;
  permission: Permission;
  execute(input: I, ctx: ToolContext): Promise<string>;
  /** compute a preview (diff / command) without mutating anything */
  preview?(input: I, ctx: ToolContext): Promise<ToolPreview | null>;
}

/** Max characters a single tool result may occupy in history (~2K tokens). */
export const TOOL_OUTPUT_CAP = 8_000;

export class ToolRegistry {
  private tools = new Map<string, Tool<unknown>>();

  register<I>(tool: Tool<I>): void {
    this.tools.set(tool.name, tool as Tool<unknown>);
  }

  get(name: string): Tool<unknown> | undefined {
    return this.tools.get(name);
  }

  list(): Tool<unknown>[] {
    return [...this.tools.values()];
  }

  schemas(): ToolSchema[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.schema) as Record<string, unknown>,
    }));
  }

  /**
   * Validate arguments. On failure returns an error string written as a
   * SELF-CORRECTION GUIDE — "Missing value for required parameter" style
   * messages send weak models into retry loops (Roo #9113).
   */
  validate(
    name: string,
    args: Record<string, unknown>,
  ): { ok: true; input: unknown } | { ok: false; error: string } {
    const tool = this.get(name);
    if (!tool) {
      const known = this.list()
        .map((t) => t.name)
        .join(", ");
      return {
        ok: false,
        error:
          `Unknown tool "${name}". Available tools: ${known}. ` +
          `Call one of these exactly by name.`,
      };
    }
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
      return {
        ok: false,
        error:
          `Invalid arguments for "${name}":\n${issues}\n` +
          `Fix ONLY the fields listed above and call "${name}" again with the corrected arguments.`,
      };
    }
    return { ok: true, input: parsed.data };
  }
}

/** Cap a tool result; the truncation notice tells the model how to get more. */
export function capOutput(out: string, hint?: string): string {
  if (out.length <= TOOL_OUTPUT_CAP) return out;
  const kept = out.slice(0, TOOL_OUTPUT_CAP);
  const dropped = out.length - TOOL_OUTPUT_CAP;
  return (
    kept +
    `\n\n[output truncated: ${dropped} characters dropped. ` +
    (hint ?? "Narrow your request (smaller range, more specific pattern) to see the rest.") +
    `]`
  );
}
