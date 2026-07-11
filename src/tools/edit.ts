// edit — SEARCH/REPLACE with the fuzzy applier. Includes the format-demotion
// ladder: after 2 consecutive failures on the same file the error tells the
// model to stop editing and rewrite via write (aider's whole-format fallback,
// implemented as guidance — costs zero harness tokens).

import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { applyEdit } from "./applier.js";
import { resolveWritable } from "./fs-guard.js";
import { diffStat } from "../cli/diff.js";
import type { Tool, ToolPreview } from "./registry.js";

const schema = z.object({
  path: z.string().describe("File to edit (relative to the working directory)"),
  search: z
    .string()
    .describe(
      "The EXACT text currently in the file to be replaced. Copy it from read output WITHOUT the line-number prefixes. Include 2-3 surrounding lines so it is unique.",
    ),
  replace: z.string().describe("The new text that replaces the search text"),
  startLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based line where the search text starts — pass this when the same text appears more than once"),
});

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

export function makeEditTool(stats: EditStats): Tool<z.infer<typeof schema>> {
  return {
    name: "edit",
    description:
      "Replace text in a file. Provide the exact current text (search) and the new text (replace). " +
      "The search text must match the file content — read the file first.",
    schema,
    readOnly: false,
    permission: "ask",
    async preview(input, ctx): Promise<ToolPreview | null> {
      const guard = resolveWritable(ctx.cwd, input.path);
      if (!guard.ok) return null;
      let content: string;
      try {
        content = await readFile(guard.path, "utf8");
      } catch {
        return null;
      }
      const result = applyEdit({ content, search: input.search, replace: input.replace, startLine: input.startLine });
      if (!result.ok) return null;
      return { kind: "diff", path: input.path, before: content, after: result.content };
    },
    async execute(input, ctx) {
      const guard = resolveWritable(ctx.cwd, input.path);
      if (!guard.ok) return guard.error;
      const path = guard.path;

      stats.attempts++;
      let content: string;
      try {
        content = await readFile(path, "utf8");
      } catch (err) {
        stats.failed++;
        return `Cannot read "${input.path}": ${(err as Error).message}. To create a new file, use write instead.`;
      }

      const result = applyEdit({
        content,
        search: input.search,
        replace: input.replace,
        startLine: input.startLine,
      });

      if (!result.ok) {
        stats.failed++;
        const streak = (failStreak.get(path) ?? 0) + 1;
        failStreak.set(path, streak);
        if (streak >= 2) {
          // Format demotion — stop burning tokens on failing diffs.
          return (
            result.error +
            `\n\n[edit has now failed ${streak} times on this file. STOP using edit here: ` +
            `call read to get the full current content, then call write with the COMPLETE corrected file.]`
          );
        }
        return result.error;
      }

      await ctx.checkpoints?.snapshot(path);
      try {
        await writeFile(path, result.content, "utf8");
      } catch (err) {
        stats.failed++;
        return `Matched but could not write "${input.path}": ${(err as Error).message}`;
      }

      failStreak.delete(path);
      stats.applied++;
      stats.byMethod[result.method]++;
      const d = diffStat(content, result.content);
      ctx.onFileChange?.(d.added, d.removed);
      const note =
        result.method === "exact"
          ? ""
          : ` (matched via ${result.method}${result.method === "fuzzy" ? `, ${Math.round(result.similarity * 100)}% similarity` : ""} — verify the change with read if unsure)`;
      return `Applied: replaced ${input.search.split(/\r?\n/).length} line(s) at line ${result.line} of ${input.path}${note}.`;
    },
  };
}
