// Mini benchmark tasks — edit-centric, small enough for 8B local models.
// Each task: fixture files + prompt + programmatic check (ground truth).
// Deliberately includes the known open-model traps: whitespace drift (tabs),
// duplicated blocks (ambiguity), multi-file coordination, new-file creation.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface EvalTask {
  name: string;
  files: Record<string, string>;
  prompt: string;
  check(dir: string): Promise<{ pass: boolean; detail: string }>;
}

async function content(dir: string, rel: string): Promise<string> {
  try {
    return await readFile(join(dir, rel), "utf8");
  } catch {
    return "";
  }
}

export const tasks: EvalTask[] = [
  {
    name: "config-value",
    files: {
      "config.json": `{\n  "host": "localhost",\n  "port": 8080,\n  "debug": true\n}\n`,
    },
    prompt: 'Change the port in config.json from 8080 to 3000.',
    async check(dir) {
      const c = await content(dir, "config.json");
      try {
        const j = JSON.parse(c) as { port?: number; host?: string };
        if (j.port === 3000 && j.host === "localhost") return { pass: true, detail: "ok" };
        return { pass: false, detail: `port is ${j.port}, expected 3000` };
      } catch {
        return { pass: false, detail: "config.json is no longer valid JSON" };
      }
    },
  },
  {
    name: "rename-function",
    files: {
      "greet.js": `function greet(name) {\n  return "Hello, " + name + "!";\n}\n\nmodule.exports = { greet };\n`,
    },
    prompt: 'In greet.js, rename the function "greet" to "welcome" (update the export too).',
    async check(dir) {
      const c = await content(dir, "greet.js");
      if (/function welcome\(/.test(c) && /welcome/.test(c.split("module.exports")[1] ?? "") && !/greet/.test(c))
        return { pass: true, detail: "ok" };
      return { pass: false, detail: "welcome not defined/exported or greet still present" };
    },
  },
  {
    name: "fix-off-by-one",
    files: {
      "sum.js": `function sumAll(arr) {\n  let total = 0;\n  for (let i = 0; i <= arr.length; i++) {\n    total += arr[i];\n  }\n  return total;\n}\nmodule.exports = { sumAll };\n`,
    },
    prompt: "sum.js has a bug: sumAll([1,2,3]) returns NaN. Find and fix it.",
    async check(dir) {
      const c = await content(dir, "sum.js");
      if (/i < arr\.length/.test(c) && !/i <= arr\.length/.test(c)) return { pass: true, detail: "ok" };
      return { pass: false, detail: "loop condition still reads past the array (i <= arr.length)" };
    },
  },
  {
    name: "tabs-whitespace",
    files: {
      "loop.py": `def process(items):\n\tresult = []\n\tfor item in items:\n\t\tif item > 0:\n\t\t\tresult.append(item * 2)\n\treturn result\n`,
    },
    prompt: "In loop.py, change the multiplier from 2 to 10 (item * 2 becomes item * 10).",
    async check(dir) {
      const c = await content(dir, "loop.py");
      if (/item \* 10/.test(c) && /\tresult = \[\]/.test(c)) return { pass: true, detail: "ok" };
      if (!/\t/.test(c)) return { pass: false, detail: "tab indentation was destroyed" };
      return { pass: false, detail: "multiplier is still 2" };
    },
  },
  {
    name: "duplicate-blocks",
    files: {
      "handlers.js": `function onCreate(req) {\n  const id = req.params.id;\n  log("event");\n  return db.save(id);\n}\n\nfunction onDelete(req) {\n  const id = req.params.id;\n  log("event");\n  return db.remove(id);\n}\n`,
    },
    prompt:
      'In handlers.js, change the log call inside onDelete (and ONLY onDelete) from log("event") to log("delete-event"). Leave onCreate unchanged.',
    async check(dir) {
      const c = await content(dir, "handlers.js");
      const createPart = c.split("function onDelete")[0] ?? "";
      const deletePart = c.split("function onDelete")[1] ?? "";
      if (/log\("event"\)/.test(createPart) && /log\("delete-event"\)/.test(deletePart))
        return { pass: true, detail: "ok" };
      return { pass: false, detail: "onDelete not updated or onCreate was also changed" };
    },
  },
  {
    name: "multi-file",
    files: {
      "limits.js": `const MAX_RETRIES = 3;\nmodule.exports = { MAX_RETRIES };\n`,
      "client.js": `const { MAX_RETRIES } = require("./limits");\n\nfunction fetchWithRetry(url) {\n  for (let i = 0; i < MAX_RETRIES; i++) {\n    // try fetch\n  }\n  throw new Error("failed after " + MAX_RETRIES + " retries");\n}\n`,
    },
    prompt:
      'Rename the constant MAX_RETRIES to RETRY_LIMIT everywhere it appears, in both limits.js and client.js.',
    async check(dir) {
      const a = await content(dir, "limits.js");
      const b = await content(dir, "client.js");
      if (/RETRY_LIMIT/.test(a) && /RETRY_LIMIT/.test(b) && !/MAX_RETRIES/.test(a + b))
        return { pass: true, detail: "ok" };
      return { pass: false, detail: "MAX_RETRIES still present or RETRY_LIMIT missing in one file" };
    },
  },
  {
    name: "new-file",
    files: {
      "index.js": `// entry point\n`,
    },
    prompt:
      'Create a new file util.js that exports a function clamp(value, min, max) returning value bounded to [min, max]. Use module.exports.',
    async check(dir) {
      const c = await content(dir, "util.js");
      if (/function clamp\(/.test(c) && /module\.exports/.test(c)) return { pass: true, detail: "ok" };
      return { pass: false, detail: "util.js missing clamp or module.exports" };
    },
  },
  {
    name: "add-validation",
    files: {
      "user.js": `function createUser(name, age) {\n  return { name, age, createdAt: Date.now() };\n}\n\nmodule.exports = { createUser };\n`,
    },
    prompt:
      'In user.js, make createUser throw an Error with message "invalid age" when age is negative. Keep everything else the same.',
    async check(dir) {
      const c = await content(dir, "user.js");
      if (/invalid age/.test(c) && /throw/.test(c) && /createdAt: Date\.now\(\)/.test(c))
        return { pass: true, detail: "ok" };
      return { pass: false, detail: "throw/invalid age missing or original body damaged" };
    },
  },

  // ---- harder tier: stress multi-file discovery, block disambiguation,
  // indentation precision, and multi-part edits (where a fuzzy applier + tools
  // + multi-turn should beat a single-shot editor). ----
  {
    name: "rename-across-callers",
    files: {
      "geo.js": `function computeArea(r) {\n  return 3.14159 * r * r;\n}\nmodule.exports = { computeArea };\n`,
      "shapes.js": `const { computeArea } = require("./geo");\nfunction circleInfo(r) {\n  return "area=" + computeArea(r);\n}\nmodule.exports = { circleInfo };\n`,
      "report.js": `const { computeArea } = require("./geo");\nconsole.log("A:", computeArea(5));\n`,
    },
    prompt:
      "Rename the function computeArea to circleArea everywhere it is defined, imported, or called across the whole project.",
    async check(dir) {
      const all = (await content(dir, "geo.js")) + (await content(dir, "shapes.js")) + (await content(dir, "report.js"));
      if (/function circleArea\(/.test(all) && !/computeArea/.test(all) && (all.match(/circleArea/g) ?? []).length >= 4)
        return { pass: true, detail: "ok" };
      return { pass: false, detail: "computeArea still present or not renamed in all 3 files" };
    },
  },
  {
    name: "precise-block",
    files: {
      "validators.js":
        `function validateEmail(v) {\n  if (!v) return false;\n  return v.includes("@");\n}\n\n` +
        `function validatePhone(v) {\n  if (!v) return false;\n  return /^[0-9]+$/.test(v);\n}\n\n` +
        `function validateZip(v) {\n  if (!v) return false;\n  return /^[0-9]+$/.test(v);\n}\n\n` +
        `module.exports = { validateEmail, validatePhone, validateZip };\n`,
    },
    prompt:
      "In validators.js, make validatePhone (and ONLY validatePhone) also return false when v has fewer than 10 characters. Do not touch validateEmail or validateZip.",
    async check(dir) {
      const c = await content(dir, "validators.js");
      const phone = c.split("function validatePhone")[1]?.split("function validateZip")[0] ?? "";
      const zip = c.split("function validateZip")[1] ?? "";
      const hasLen = /\.length\s*<\s*10|<\s*10/.test(phone);
      if (hasLen && !/length/.test(zip) && /validateEmail/.test(c)) return { pass: true, detail: "ok" };
      return { pass: false, detail: "length check missing in validatePhone or leaked into another function" };
    },
  },
  {
    name: "nested-indent-insert",
    files: {
      "service.py": `def handle(req):\n    if req.valid:\n        for item in req.items:\n            process(item)\n    return "done"\n`,
    },
    prompt:
      "In service.py, inside the for loop right after the process(item) line, add a new line that calls log(item). It must sit at the same indentation as process(item).",
    async check(dir) {
      const c = await content(dir, "service.py");
      // log(item) must be indented 12 spaces (same as process(item)) and structure intact
      if (/\n {12}log\(item\)/.test(c) && /\n {12}process\(item\)/.test(c) && /return "done"/.test(c))
        return { pass: true, detail: "ok" };
      return { pass: false, detail: "log(item) missing or wrong indentation (must match process(item))" };
    },
  },
  {
    name: "multi-part-edit",
    files: {
      "api.js": `function send(url, retries, verbose) {\n  if (verbose) {\n    console.log("sending", url);\n  }\n  return fetch(url, retries);\n}\n\nsend("/data", 3, true);\n`,
    },
    prompt:
      'In api.js, remove the unused "verbose" feature: delete the verbose parameter, delete the whole "if (verbose) { ... }" block, and update the call site to send("/data", 3). Leave the fetch line unchanged.',
    async check(dir) {
      const c = await content(dir, "api.js");
      if (!/verbose/.test(c) && !/console\.log/.test(c) && /send\("\/data", 3\)/.test(c) && /fetch\(url, retries\)/.test(c))
        return { pass: true, detail: "ok" };
      return { pass: false, detail: "verbose/console.log still present, or call site/fetch damaged" };
    },
  },
];
