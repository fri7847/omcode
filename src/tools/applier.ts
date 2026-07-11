// Fuzzy patch applier — half of edit reliability lives here, not in the
// prompt (aider: disabling flexible matching made errors 9x worse).
//
// Matching ladder, cheapest/safest first (DESIGN.md §5):
//   1. exact        — byte-identical line window
//   2. normalized   — per-line trimmed comparison (whitespace drift)
//   3. fuzzy        — Levenshtein similarity ≥ threshold, with optional
//                     startLine hint searched middle-out in a ±BUFFER window
//                     (Roo Code's algorithm)
//
// Failure output is a SELF-CORRECTION GUIDE: show the best near-miss with
// line numbers and similarity so the model can fix its SEARCH text in ONE
// retry instead of looping (Roo #9113 lesson).

export interface ApplyRequest {
  content: string;
  search: string;
  replace: string;
  /** 1-based line hint where the search block is expected to start */
  startLine?: number;
  /** similarity threshold for fuzzy matching (default 0.9) */
  threshold?: number;
}

export type MatchMethod = "exact" | "normalized" | "fuzzy";

export type ApplyResult =
  | {
      ok: true;
      content: string;
      method: MatchMethod;
      /** 1-based line where the match started */
      line: number;
      similarity: number;
    }
  | { ok: false; error: string; bestSimilarity: number };

const FUZZY_BUFFER = 40; // lines around startLine hint to search first
const AMBIGUITY_EPSILON = 0.02;

export function applyEdit(req: ApplyRequest): ApplyResult {
  const eol = req.content.includes("\r\n") ? "\r\n" : "\n";
  const lines = req.content.split(/\r?\n/);
  const searchLines = splitBlock(req.search);
  const replaceLines = splitBlock(req.replace);

  if (req.search.trim() === "") {
    return {
      ok: false,
      bestSimilarity: 0,
      error:
        "SEARCH text is empty. To create a new file or fully rewrite one, use the write tool instead of edit.",
    };
  }
  if (req.search === req.replace) {
    return {
      ok: false,
      bestSimilarity: 1,
      error: "SEARCH and REPLACE are identical — this edit changes nothing. Provide the modified text in REPLACE.",
    };
  }

  // ---- 1. exact ----
  const exact = findWindows(lines, searchLines, (a, b) => a === b);
  if (exact.length === 1) {
    return splice(lines, exact[0]!, searchLines.length, replaceLines, eol, "exact", 1);
  }
  if (exact.length > 1) {
    // A startLine hint disambiguates duplicates (as the ambiguity message
    // itself instructs) — pick the occurrence nearest the hint.
    if (req.startLine !== undefined) {
      return splice(lines, nearest(exact, req.startLine), searchLines.length, replaceLines, eol, "exact", 1);
    }
    return ambiguityError(exact, searchLines.length, "exactly", lines);
  }

  // ---- 2. normalized (per-line trim) ----
  const norm = findWindows(lines, searchLines, (a, b) => a.trim() === b.trim());
  if (norm.length === 1) {
    return splice(lines, norm[0]!, searchLines.length, replaceLines, eol, "normalized", 1);
  }
  if (norm.length > 1) {
    if (req.startLine !== undefined) {
      return splice(lines, nearest(norm, req.startLine), searchLines.length, replaceLines, eol, "normalized", 1);
    }
    return ambiguityError(norm, searchLines.length, "after whitespace normalization", lines);
  }

  // ---- 3. fuzzy (Levenshtein over the joined trimmed window) ----
  const threshold = req.threshold ?? 0.9;
  const target = searchLines.map((l) => l.trim()).join("\n");
  const candidates = candidateOrder(lines.length, searchLines.length, req.startLine);

  let best = { index: -1, score: 0 };
  let second = { index: -1, score: 0 };
  for (const i of candidates) {
    const window = lines
      .slice(i, i + searchLines.length)
      .map((l) => l.trim())
      .join("\n");
    // cheap length pre-filter before O(n·m) Levenshtein
    if (Math.abs(window.length - target.length) / Math.max(target.length, 1) > 1 - threshold + 0.1) {
      continue;
    }
    const score = similarity(window, target);
    if (score > best.score) {
      second = best;
      best = { index: i, score };
    } else if (score > second.score && i !== best.index) {
      second = { index: i, score };
    }
  }

  if (best.score >= threshold) {
    // With a startLine hint, ties are already resolved by proximity: the
    // candidate order is middle-out from the hint and only a strictly better
    // score can displace an earlier (closer) window. Without a hint, a
    // near-tie is genuine ambiguity — reject with guidance.
    if (
      req.startLine === undefined &&
      second.score >= threshold &&
      best.score - second.score < AMBIGUITY_EPSILON
    ) {
      return ambiguityError(
        [best.index, second.index],
        searchLines.length,
        `with ~${Math.round(best.score * 100)}% similarity`,
        lines,
      );
    }
    return splice(lines, best.index, searchLines.length, replaceLines, eol, "fuzzy", best.score);
  }

  // ---- failure: build the self-correction guide ----
  return {
    ok: false,
    bestSimilarity: best.score,
    error: failureGuide(lines, best, searchLines.length, threshold),
  };
}

// ---------- helpers ----------

function splitBlock(s: string): string[] {
  const lines = s.split(/\r?\n/);
  // A single trailing newline in the block is formatting, not content.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function findWindows(
  lines: string[],
  search: string[],
  eq: (a: string, b: string) => boolean,
): number[] {
  const hits: number[] = [];
  outer: for (let i = 0; i + search.length <= lines.length; i++) {
    for (let j = 0; j < search.length; j++) {
      if (!eq(lines[i + j]!, search[j]!)) continue outer;
    }
    hits.push(i);
  }
  return hits;
}

/** The index closest to a 1-based startLine hint (for duplicate resolution). */
function nearest(indices: number[], startLine: number): number {
  const center = startLine - 1;
  return indices.reduce((best, i) => (Math.abs(i - center) < Math.abs(best - center) ? i : best), indices[0]!);
}

/** Middle-out order around the hint, then the rest of the file. */
function candidateOrder(total: number, windowLen: number, startLine?: number): number[] {
  const max = total - windowLen;
  if (max < 0) return [];
  const all: number[] = [];
  if (startLine !== undefined) {
    const center = Math.min(Math.max(startLine - 1, 0), max);
    for (let d = 0; d <= FUZZY_BUFFER; d++) {
      if (center + d <= max) all.push(center + d);
      if (d > 0 && center - d >= 0) all.push(center - d);
    }
    for (let i = 0; i <= max; i++) {
      if (Math.abs(i - center) > FUZZY_BUFFER) all.push(i);
    }
  } else {
    for (let i = 0; i <= max; i++) all.push(i);
  }
  return all;
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function levenshtein(a: string, b: string): number {
  if (a.length > b.length) [a, b] = [b, a];
  let prev = new Array<number>(a.length + 1);
  let curr = new Array<number>(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;
  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    const bc = b.charCodeAt(j - 1);
    for (let i = 1; i <= a.length; i++) {
      const cost = a.charCodeAt(i - 1) === bc ? 0 : 1;
      curr[i] = Math.min(prev[i]! + 1, curr[i - 1]! + 1, prev[i - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[a.length]!;
}

function splice(
  lines: string[],
  index: number,
  searchLen: number,
  replaceLines: string[],
  eol: string,
  method: MatchMethod,
  score: number,
): ApplyResult {
  const out = [...lines.slice(0, index), ...replaceLines, ...lines.slice(index + searchLen)];
  return { ok: true, content: out.join(eol), method, line: index + 1, similarity: score };
}

function ambiguityError(
  indices: number[],
  windowLen: number,
  how: string,
  lines: string[],
): ApplyResult {
  const spots = indices
    .slice(0, 4)
    .map((i) => `line ${i + 1}`)
    .join(", ");
  const first = indices[0]!;
  const preview = lines
    .slice(Math.max(0, first - 2), first + windowLen + 2)
    .map((l, k) => `${Math.max(0, first - 2) + k + 1}| ${l}`)
    .join("\n");
  return {
    ok: false,
    bestSimilarity: 1,
    error:
      `SEARCH matches ${how} at multiple locations (${spots}). ` +
      `Make it unique: include 2-3 more surrounding lines in SEARCH, or pass startLine with the line number of the occurrence you mean.\n` +
      `First occurrence context:\n${preview}`,
  };
}

function failureGuide(
  lines: string[],
  best: { index: number; score: number },
  windowLen: number,
  threshold: number,
): string {
  if (best.index < 0) {
    return (
      `SEARCH text not found in the file (no candidate came close). ` +
      `Read the file first and copy the SEARCH block EXACTLY from its current content — do not retype it from memory, and do not include the line-number prefix from read output.`
    );
  }
  const start = best.index;
  const snippet = lines
    .slice(start, start + Math.min(windowLen, 12))
    .map((l, k) => `${start + k + 1}| ${l}`)
    .join("\n");
  return (
    `SEARCH text not found. Closest match is at line ${start + 1} with ${Math.round(best.score * 100)}% similarity ` +
    `(needs ≥${Math.round(threshold * 100)}%). The file ACTUALLY contains:\n${snippet}\n` +
    `Copy your SEARCH block from the text above exactly (without the "N|" prefixes), then call edit again.`
  );
}
