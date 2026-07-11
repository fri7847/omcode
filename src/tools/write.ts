import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { resolveWritable } from "./fs-guard.js";
import { diffStat } from "../cli/diff.js";
import type { Tool, ToolPreview } from "./registry.js";

const schema = z.object({
  path: z.string().describe("File to create or overwrite (relative to the working directory)"),
  content: z.string().describe("The COMPLETE file content — this replaces the whole file"),
});

export const writeTool: Tool<z.infer<typeof schema>> = {
  name: "write",
  description:
    "Create a new file or overwrite an existing one with complete content. " +
    "For small changes to an existing file, prefer edit.",
  schema,
  readOnly: false,
  permission: "ask",
  async preview(input, ctx): Promise<ToolPreview | null> {
    const guard = resolveWritable(ctx.cwd, input.path);
    if (!guard.ok) return null;
    let before = "";
    try {
      before = await readFile(guard.path, "utf8");
    } catch {
      before = ""; // new file
    }
    return { kind: "diff", path: input.path, before, after: input.content };
  },
  async execute(input, ctx) {
    const guard = resolveWritable(ctx.cwd, input.path);
    if (!guard.ok) return guard.error;
    let before = "";
    try {
      before = await readFile(guard.path, "utf8");
    } catch {
      before = "";
    }
    await ctx.checkpoints?.snapshot(guard.path);
    try {
      await mkdir(dirname(guard.path), { recursive: true });
      await writeFile(guard.path, input.content, "utf8");
    } catch (err) {
      return `Cannot write "${input.path}": ${(err as Error).message}`;
    }
    const d = diffStat(before, input.content);
    ctx.onFileChange?.(d.added, d.removed);
    const lines = input.content.split(/\r?\n/).length;
    return `Wrote ${input.path} (${lines} lines).`;
  },
};
