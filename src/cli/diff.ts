// Diff rendering — gutter (+/-) + colored background blocks + word-level
// highlight, the cross-harness consensus format (Claude Code / Codex / Gemini
// / OpenCode / Crush all do this; Aider's "whole old then whole new" is the
// counter-example we avoid). Pure functions so they're unit-testable.

const R = "\x1b[0m";
// OMcode diff palette — muted so syntax/text stays readable, our own values
// (green/red is the universal diff convention, not any harness's identity).
const BG_ADD = "\x1b[48;2;18;46;33m"; // deep teal-green
const BG_DEL = "\x1b[48;2;54;24;30m"; // deep maroon
const BG_ADD_WORD = "\x1b[48;2;34;92;58m"; // brighter — the changed tokens
const BG_DEL_WORD = "\x1b[48;2;104;44;54m";
const FG_ADD = "\x1b[38;2;134;222;170m";
const FG_DEL = "\x1b[38;2;236;150;160m";
const DIM = "\x1b[38;2;120;120;128m";
const GUT_ADD = "\x1b[38;2;74;222;128m";
const GUT_DEL = "\x1b[38;2;248;113;113m";

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk";
  oldNo?: number;
  newNo?: number;
  text: string;
}

/** LCS-based line diff (Myers-equivalent for our sizes). */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  // drop a single trailing empty line so a final newline isn't shown as a change
  if (a.length > 1 && a[a.length - 1] === "") a.pop();
  if (b.length > 1 && b[b.length - 1] === "") b.pop();

  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "del", oldNo: oldNo++, text: a[i]! });
      i++;
    } else {
      out.push({ kind: "add", newNo: newNo++, text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", oldNo: oldNo++, text: a[i++]! });
  while (j < m) out.push({ kind: "add", newNo: newNo++, text: b[j++]! });
  return out;
}

/** Collapse long runs of context, keeping `pad` lines around each change. */
export function collapseContext(lines: DiffLine[], pad = 2): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.kind === "add" || l.kind === "del") {
      for (let k = Math.max(0, idx - pad); k <= Math.min(lines.length - 1, idx + pad); k++) keep[k] = true;
    }
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (skipped > 0) {
        out.push({ kind: "hunk", text: `⋯ ${skipped} unchanged line${skipped === 1 ? "" : "s"} ⋯` });
        skipped = 0;
      }
      out.push(l);
    } else {
      skipped++;
    }
  });
  return out;
}

/** Char-level intra-line highlight for a del/add pair. */
function wordSpans(oldText: string, newText: string): { del: string; add: string } {
  const a = [...oldText];
  const b = [...newText];
  // common prefix / suffix — cheap and reads well for typical edits
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const delMid = a.slice(p, a.length - s).join("");
  const addMid = b.slice(p, b.length - s).join("");
  const pre = a.slice(0, p).join("");
  const delSuf = a.slice(a.length - s).join("");
  const addSuf = b.slice(b.length - s).join("");
  const del = delMid
    ? `${BG_DEL}${FG_DEL}${pre}${BG_DEL_WORD}${delMid}${R}${BG_DEL}${FG_DEL}${delSuf}${R}`
    : `${BG_DEL}${FG_DEL}${oldText}${R}`;
  const add = addMid
    ? `${BG_ADD}${FG_ADD}${pre}${BG_ADD_WORD}${addMid}${R}${BG_ADD}${FG_ADD}${addSuf}${R}`
    : `${BG_ADD}${FG_ADD}${newText}${R}`;
  return { del, add };
}

export interface RenderDiffOptions {
  color: boolean;
  /** left indent for the whole block */
  indent?: string;
  /** file path for the header line */
  path?: string;
}

/**
 * Render a diff to a string. Pairs adjacent del→add lines for word-highlight.
 * Line-number gutter (right-aligned) + sign gutter + colored background.
 */
export function renderDiff(before: string, after: string, opts: RenderDiffOptions): string {
  const lines = collapseContext(lineDiff(before, after));
  const indent = opts.indent ?? "  ";
  const numW = Math.max(
    2,
    String(Math.max(...lines.map((l) => Math.max(l.oldNo ?? 0, l.newNo ?? 0)))).length,
  );
  const rows: string[] = [];
  if (opts.path) {
    rows.push(indent + (opts.color ? `${DIM}${opts.path}${R}` : opts.path));
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const l = lines[idx]!;
    if (l.kind === "hunk") {
      rows.push(indent + (opts.color ? `${DIM}${l.text}${R}` : l.text));
      continue;
    }
    const num = (l.oldNo ?? l.newNo ?? 0).toString().padStart(numW);
    // pair a del immediately followed by an add → word highlight
    if (l.kind === "del" && lines[idx + 1]?.kind === "add") {
      const next = lines[idx + 1]!;
      if (opts.color) {
        const { del, add } = wordSpans(l.text, next.text);
        rows.push(`${indent}${DIM}${num}${R} ${GUT_DEL}-${R} ${del}`);
        const num2 = (next.newNo ?? 0).toString().padStart(numW);
        rows.push(`${indent}${DIM}${num2}${R} ${GUT_ADD}+${R} ${add}`);
      } else {
        rows.push(`${indent}${num} - ${l.text}`);
        rows.push(`${indent}${num} + ${next.text}`);
      }
      idx++; // consumed the add
      continue;
    }
    if (l.kind === "add") {
      rows.push(opts.color ? `${indent}${DIM}${num}${R} ${GUT_ADD}+${R} ${BG_ADD}${FG_ADD}${l.text}${R}` : `${indent}${num} + ${l.text}`);
    } else if (l.kind === "del") {
      rows.push(opts.color ? `${indent}${DIM}${num}${R} ${GUT_DEL}-${R} ${BG_DEL}${FG_DEL}${l.text}${R}` : `${indent}${num} - ${l.text}`);
    } else {
      rows.push(opts.color ? `${indent}${DIM}${num}   ${l.text}${R}` : `${indent}${num}   ${l.text}`);
    }
  }
  return rows.join("\n");
}

/** +N/-M line change counts for a diff (for the status line / footer). */
export function diffStat(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lineDiff(before, after)) {
    if (l.kind === "add") added++;
    else if (l.kind === "del") removed++;
  }
  return { added, removed };
}
