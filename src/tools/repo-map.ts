import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import { z } from "zod";
import { buildRepoMap, renderRepoMap, type RepoMapFile } from "../core/repo-map.js";
import { capOutput, type Tool } from "./registry.js";

const schema = z.object({
  focus: z.string().optional().describe("Optional file path or symbol name to prioritize"),
  maxFiles: z.number().int().min(1).max(80).optional().describe("Maximum mapped files (default 40)"),
});

const SOURCE_GLOB = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,py,go,rs,java,rb}";
const MAX_SOURCE_FILES = 1_000;
const MAX_FILE_BYTES = 250_000;

export const repoMapTool: Tool<z.infer<typeof schema>> = {
  name: "repo_map",
  description:
    "Build a compact map of important source files and their top-level definitions. " +
    "Use this first for multi-file work, then read the relevant files before editing.",
  schema,
  readOnly: true,
  permission: "allow",
  async execute(input, ctx) {
    const paths = await fg(SOURCE_GLOB, {
      cwd: ctx.cwd,
      onlyFiles: true,
      dot: false,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/coverage/**"],
    });
    const files: RepoMapFile[] = [];
    for (const file of paths.slice(0, MAX_SOURCE_FILES)) {
      try {
        const content = await readFile(`${ctx.cwd}/${file}`, "utf8");
        if (content.length <= MAX_FILE_BYTES && !content.includes("\0")) files.push({ path: file, content });
      } catch {
        // A file disappearing during a map scan is harmless; the model can use glob/read if needed.
      }
    }
    const map = renderRepoMap(buildRepoMap(files, { focus: input.focus, maxFiles: input.maxFiles }));
    const omitted = paths.length > MAX_SOURCE_FILES ? `\n[${paths.length - MAX_SOURCE_FILES} source files omitted]` : "";
    return capOutput(map + omitted, "Use repo_map with focus, or read the relevant mapped file.");
  },
};
