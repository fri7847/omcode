// edit — batched SEARCH/REPLACE via the fuzzy applier. Takes a LIST of edits
// (across any files) applied in one call, so a weak model states every change
// at once instead of editing one thing and stopping (the failure mode the
// cross-harness benchmark exposed vs aider's single-shot editing). Keeps the
// fuzzy matching + format-demotion ladder per file.

import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { applyEdit } from "./applier.js";
import { resolveWritable } from "./fs-guard.js";
import { diffStat } from "../cli/diff.js";
import type { Tool, ToolPreview } from "./registry.js";

const editItem = z.object({
  path: z.string().describe("File to edit (relative to the working directory)"),
  search: z
    .string()
    .describe(
      "The EXACT current text to replace. Copy it from read output WITHOUT the line-number prefixes. Include 2-3 surrounding lines so it matches only one place.",
    ),
  replace: z.string().describe("The new text that replaces search"),
  startLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based line where search starts — pass this when the same text appears more than once"),
});

const schema = z.object({
  edits: z
    .array(editItem)
    .min(1)
    .describe(
      "EVERY change to make, across all files, in ONE call. If the request needs several edits or touches several files, list them all here — do not make one edit and stop. Applied in order (later edits see earlier ones).",
    ),
});

type EditInput = z.infer<typeof schema>;

export interface EditStats {
  attempts: number;
  applied: number;
  byMethod: { exact: number; normalized: number; fuzzy: number };
  failed: number;
}

export function newEditStats(): EditStats {
  return { attempts: 0, applied: 0, byMethod: { exact: 0, normalized: 0, fuzzy: 0 }, failed: 0 };
}

/** consecutive failures per file → demotion guidance at 2 */
const failStreak = new Map<string, number>();

export function makeEditTool(stats: EditStats): Tool<EditInput> {
  return {
    name: "edit",
    description:
      "Apply one or more SEARCH/REPLACE edits in a single call. Pass an `edits` array — batch EVERY change the task needs " +
      "(multiple parts, multiple files) into this one call so nothing is left half-done. Read each file before editing it.",
    schema,
    readOnly: false,
    permission: "ask",
    async preview(input, ctx): Promise<ToolPreview | null> {
      // Best-effort: preview the combined change to the first file touched.
      const first = input.edits[0]!;
      const guard = resolveWritable(ctx.cwd, first.path);
      if (!guard.ok) return null;
      let content: string;
      try {
        content = await readFile(guard.path, "utf8");
      } catch {
        return null;
      }
      const before = content;
      for (const e of input.edits) {
        const g = resolveWritable(ctx.cwd, e.path);
        if (!g.ok || g.path !== guard.path) continue;
        const r = applyEdit({ content, search: e.search, replace: e.replace, startLine: e.startLine });
        if (r.ok) content = r.content;
      }
      if (content === before) return null;
      const others = new Set(input.edits.map((e) => e.path)).size - 1;
      return { kind: "diff", path: first.path + (others > 0 ? ` (+${others} more file${others === 1 ? "" : "s"})` : ""), before, after: content };
    },
    async execute(input, ctx) {
      const lines: string[] = [];
      let applied = 0;
      const cache = new Map<string, string>(); // absPath -> current in-memory content

      for (const [i, e] of input.edits.entries()) {
        stats.attempts++;
        const label = `edit ${i + 1}/${input.edits.length} (${e.path})`;
        const guard = resolveWritable(ctx.cwd, e.path);
        if (!guard.ok) {
          stats.failed++;
          lines.push(`✗ ${label}: ${guard.error}`);
          continue;
        }
        const path = guard.path;

        let content = cache.get(path);
        if (content === undefined) {
          try {
            content = await readFile(path, "utf8");
          } catch (err) {
            stats.failed++;
            lines.push(`✗ ${label}: cannot read — ${(err as Error).message}. Use write to create a new file.`);
            continue;
          }
        }

        const result = applyEdit({ content, search: e.search, replace: e.replace, startLine: e.startLine });
        if (!result.ok) {
          stats.failed++;
          const streak = (failStreak.get(path) ?? 0) + 1;
          failStreak.set(path, streak);
          const demote =
            streak >= 2
              ? ` [failed ${streak}x on this file — stop editing it: read the full content and use write with the complete corrected file.]`
              : "";
          lines.push(`✗ ${label} FAILED: ${result.error}${demote}`);
          continue;
        }

        await ctx.checkpoints?.snapshot(path);
        try {
          await writeFile(path, result.content, "utf8");
        } catch (err) {
          stats.failed++;
          lines.push(`✗ ${label}: matched but write failed — ${(err as Error).message}`);
          continue;
        }
        const d = diffStat(content, result.content);
        ctx.onFileChange?.(d.added, d.removed);
        cache.set(path, result.content);
        failStreak.delete(path);
        stats.applied++;
        stats.byMethod[result.method]++;
        applied++;
        const note = result.method === "exact" ? "" : ` [${result.method}${result.method === "fuzzy" ? ` ${Math.round(result.similarity * 100)}%` : ""}]`;
        lines.push(`✓ ${label}: applied at line ${result.line}${note}`);
      }

      const total = input.edits.length;
      const head =
        applied === total
          ? `Applied all ${total} edit${total === 1 ? "" : "s"}.`
          : `Applied ${applied}/${total} edits — fix the failed ones below and call edit again with ONLY those.`;
      return `${head}\n${lines.join("\n")}`;
    },
  };
}
