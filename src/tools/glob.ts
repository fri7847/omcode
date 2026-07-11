import fg from "fast-glob";
import { z } from "zod";
import { capOutput, type Tool } from "./registry.js";

const schema = z.object({
  pattern: z
    .string()
    .describe('Glob pattern, e.g. "src/**/*.ts" or "**/*.json"'),
});

const MAX_RESULTS = 200;

export const globTool: Tool<z.infer<typeof schema>> = {
  name: "glob",
  description:
    "Find files by glob pattern (relative to the working directory). " +
    "Returns matching paths, newest first.",
  schema,
  readOnly: true,
  permission: "allow",
  async execute(input, ctx) {
    let entries;
    try {
      entries = await fg(input.pattern, {
        cwd: ctx.cwd,
        dot: false,
        onlyFiles: true,
        stats: true,
        ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
      });
    } catch (err) {
      return `Invalid glob pattern "${input.pattern}": ${(err as Error).message}`;
    }
    if (entries.length === 0) {
      return `No files match "${input.pattern}". Try a broader pattern like "**/*<name>*".`;
    }
    entries.sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0));
    const shown = entries.slice(0, MAX_RESULTS);
    let out = shown.map((e) => e.path).join("\n");
    if (entries.length > MAX_RESULTS) {
      out += `\n[${entries.length - MAX_RESULTS} more matches omitted — narrow the pattern]`;
    }
    return capOutput(out);
  },
};
