// Compact repository map for multi-file work.  It deliberately uses a small
// lexical extractor instead of a parser dependency: the map is a routing hint,
// never an authority on source semantics.  Models must still read files before
// editing them.

import path from "node:path";

export interface RepoMapFile {
  path: string;
  content: string;
}

export interface RepoMapEntry {
  path: string;
  score: number;
  definitions: string[];
}

export interface RepoMapOptions {
  maxFiles?: number;
  focus?: string;
}

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".rb"];
const DEFINITION = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:class|function|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/;
const PYTHON_DEFINITION = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/;
const GO_DEFINITION = /^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)/;

function normalize(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function definitions(content: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < content.split(/\r?\n/).length; i++) {
    const line = content.split(/\r?\n/)[i]!;
    const name = line.match(DEFINITION)?.[1] ?? line.match(PYTHON_DEFINITION)?.[1] ?? line.match(GO_DEFINITION)?.[1];
    if (name && !found.includes(name)) found.push(`${name}:${i + 1}`);
  }
  return found;
}

function importSpecifiers(content: string): string[] {
  const specs: string[] = [];
  const pattern = /(?:from\s*|import\s*\(?\s*|require\s*\()\s*["']([^"']+)["']/g;
  for (const match of content.matchAll(pattern)) {
    const spec = match[1];
    if (spec?.startsWith(".")) specs.push(spec);
  }
  return specs;
}

function resolveImport(from: string, specifier: string, known: Set<string>): string | undefined {
  const base = normalize(path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)));
  const candidates = [base, ...EXTENSIONS.map((ext) => base + ext), ...EXTENSIONS.map((ext) => `${base}/index${ext}`)];
  return candidates.find((candidate) => known.has(candidate));
}

/**
 * Rank files by the relative-import graph, then return a short, stable map.
 * PageRank has a useful failure mode here: isolated files still appear, while
 * shared modules rise naturally without asking the model to inspect every file.
 */
export function buildRepoMap(files: RepoMapFile[], options: RepoMapOptions = {}): RepoMapEntry[] {
  const normalized = files.map((file) => ({ ...file, path: normalize(file.path) }));
  const known = new Set(normalized.map((file) => file.path));
  const outgoing = new Map<string, string[]>();
  for (const file of normalized) {
    const targets = importSpecifiers(file.content)
      .map((specifier) => resolveImport(file.path, specifier, known))
      .filter((target): target is string => target !== undefined);
    outgoing.set(file.path, [...new Set(targets)]);
  }

  const size = normalized.length;
  const rank = new Map(normalized.map((file) => [file.path, size === 0 ? 0 : 1 / size]));
  if (size > 0) {
    for (let round = 0; round < 20; round++) {
      const next = new Map(normalized.map((file) => [file.path, 0.15 / size]));
      for (const file of normalized) {
        const targets = outgoing.get(file.path) ?? [];
        const share = 0.85 * (rank.get(file.path) ?? 0) / (targets.length || size);
        for (const target of targets.length ? targets : normalized.map((entry) => entry.path)) {
          next.set(target, (next.get(target) ?? 0) + share);
        }
      }
      rank.clear();
      for (const [file, score] of next) rank.set(file, score);
    }
  }

  const focus = options.focus?.trim().toLowerCase();
  const entries = normalized.map((file) => {
    const defs = definitions(file.content);
    const searchable = `${file.path} ${defs.join(" ")}`.toLowerCase();
    const boost = focus && searchable.includes(focus) ? 1 : 0;
    return { path: file.path, score: (rank.get(file.path) ?? 0) + boost, definitions: defs };
  });
  return entries
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, options.maxFiles ?? 40);
}

export function renderRepoMap(entries: RepoMapEntry[]): string {
  if (entries.length === 0) return "No supported source files were found. Try glob/read for this repository.";
  return entries
    .map((entry) => {
      const defs = entry.definitions.length ? ` — ${entry.definitions.slice(0, 10).join(", ")}` : "";
      return `${entry.path}${defs}`;
    })
    .join("\n");
}
