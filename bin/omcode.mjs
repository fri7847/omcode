#!/usr/bin/env node
// Global `omcode` command — runs the REPL through tsx so flags pass straight
// through: `omcode --resume list` (no `npm run dev -- …` dance).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const repl = join(root, "src", "cli", "repl.ts");

const child = spawn(process.execPath, [tsxCli, repl, ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
