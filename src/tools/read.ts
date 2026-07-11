import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { capOutput, type Tool } from "./registry.js";

const schema = z.object({
  path: z.string().describe("File path (absolute, or relative to the working directory)"),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based line number to start reading from (default 1)"),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Maximum number of lines to read (default 400)"),
});

const DEFAULT_LIMIT = 400;

export const readTool: Tool<z.infer<typeof schema>> = {
  name: "read",
  description:
    "Read a text file. Returns numbered lines. Large files are windowed — " +
    "use offset/limit to read a specific range.",
  schema,
  readOnly: true,
  permission: "allow",
  async execute(input, ctx) {
    const path = resolve(ctx.cwd, input.path);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      return `Cannot read "${input.path}": ${(err as Error).message}. Check the path with the glob tool if unsure.`;
    }
    const lines = raw.split(/\r?\n/);
    const offset = input.offset ?? 1;
    const limit = input.limit ?? DEFAULT_LIMIT;
    if (offset > lines.length) {
      return `File has only ${lines.length} lines but offset was ${offset}. Use offset <= ${lines.length}.`;
    }
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const width = String(offset - 1 + slice.length).length;
    const body = slice
      .map((l, i) => `${String(offset + i).padStart(width)}\t${l}`)
      .join("\n");
    const footer =
      offset - 1 + slice.length < lines.length
        ? `\n[showing lines ${offset}-${offset - 1 + slice.length} of ${lines.length}. Call read again with offset=${offset + slice.length} for more.]`
        : "";
    return capOutput(body + footer, "Use offset/limit to read a smaller range.");
  },
};
