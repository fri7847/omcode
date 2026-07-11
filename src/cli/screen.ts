// Fixed-chrome layout. Header (top), status + input (bottom) stay put; only the
// middle output region scrolls. Implemented with a DECSTBM scroll region (no
// alt-screen, so the terminal's own scrollback above the region is preserved
// and the session isn't wiped on exit). Chrome is painted with save/restore
// (DECSC/DECRC) around absolute cursor moves. TTY only.

import { stdin, stdout } from "node:process";

const ESC = "\x1b";
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;
const SAVE = `${ESC}7`;
const REST = `${ESC}8`;
const CLR_LINE = `${ESC}[2K`;
const TEAL = `${ESC}[38;2;45;212;191m`;
const DIMC = `${ESC}[38;2;120;120;128m`;
const RS = `${ESC}[0m`;

const HEADER_ROWS = 2; // title + a blank breathing line
const STATUS_ROWS = 1;
const INPUT_ROWS = 2; // a blank breathing line + the input row

function at(row: number, col = 1): string {
  return `${ESC}[${row};${col}H`;
}

function vlen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export class FixedScreen {
  rows = stdout.rows || 24;
  cols = stdout.columns || 80;
  private header = "";
  private status = "";
  private started = false;
  private onResize = () => this.relayout();

  get regionTop(): number {
    return HEADER_ROWS + 1;
  }
  get regionBottom(): number {
    return this.rows - STATUS_ROWS - INPUT_ROWS;
  }
  private get statusRow(): number {
    return this.rows - INPUT_ROWS;
  }
  private get inputRow(): number {
    return this.rows;
  }
  /** the blank breathing row just above the input — used for the suggestion strip */
  private get suggestRow(): number {
    return this.rows - 1;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.rows = stdout.rows || 24;
    this.cols = stdout.columns || 80;
    // scroll the existing content up so we have a clean region to work in,
    // WITHOUT alt-screen (previous lines remain in scrollback).
    stdout.write("\n".repeat(this.rows));
    this.setRegion();
    stdout.on("resize", this.onResize);
    stdout.write(at(this.regionTop, 1));
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    stdout.off("resize", this.onResize);
    stdout.write(`${ESC}[r`); // reset scroll region
    stdout.write(at(this.rows, 1) + SHOW + "\n");
  }

  private setRegion(): void {
    stdout.write(`${ESC}[${this.regionTop};${this.regionBottom}r`);
  }

  private relayout(): void {
    this.rows = stdout.rows || 24;
    this.cols = stdout.columns || 80;
    stdout.write(SAVE);
    this.setRegion();
    this.paintHeader();
    this.paintStatus();
    stdout.write(REST);
  }

  setHeader(text: string): void {
    this.header = text;
    stdout.write(SAVE);
    this.paintHeader();
    stdout.write(REST);
  }

  setStatus(text: string): void {
    this.status = text;
    stdout.write(SAVE);
    this.paintStatus();
    stdout.write(REST);
  }

  private paintHeader(): void {
    stdout.write(at(1, 1) + CLR_LINE + " " + clip(this.header, this.cols - 1));
    stdout.write(at(2, 1) + CLR_LINE + DIMC + " " + "─".repeat(Math.max(0, this.cols - 2)) + RS);
  }
  private paintStatus(): void {
    stdout.write(at(this.statusRow, 1) + CLR_LINE + "  " + clip(this.status, this.cols - 2));
  }

  /** Draw the input row with the cursor placed inside it. Optional dim `ghost`
   * text is shown after the buffer (autocomplete preview) without moving the cursor. */
  drawInput(buffer: string, cursor: number, ghost = ""): void {
    const prompt = ` ${TEAL}»${RS} `;
    const promptW = 3;
    const avail = Math.max(4, this.cols - promptW - 1);
    let start = 0;
    if (cursor > avail) start = cursor - avail;
    const view = buffer.slice(start, start + avail);
    const tail = ghost ? DIMC + clip(ghost, Math.max(0, avail - view.length)) + RS : "";
    stdout.write(at(this.inputRow, 1) + CLR_LINE + prompt + view + tail);
    stdout.write(at(this.inputRow, promptW + 1 + (cursor - start)));
  }

  /** Suggestion strip on the breathing row above the input. Empty clears it.
   * Does NOT use the DECSC/DECRC save slot (the caller owns that) — it just
   * paints the row; the caller repositions the cursor with drawInput afterward. */
  drawSuggestions(labels: string[], active = 0): void {
    stdout.write(at(this.suggestRow, 1) + CLR_LINE);
    if (labels.length > 0) {
      const parts = labels.map((n, i) => (i === active ? `${TEAL}${n}${RS}` : `${DIMC}${n}${RS}`));
      stdout.write("  " + clip(parts.join("  "), this.cols - 2));
    }
  }

  saveCursor(): void {
    stdout.write(SAVE);
  }
  restoreCursor(): void {
    stdout.write(REST);
  }
  showCursor(): void {
    stdout.write(SHOW);
  }
  hideCursor(): void {
    stdout.write(HIDE);
  }
}

function clip(s: string, cols: number): string {
  if (vlen(s) <= cols) return s;
  let out = "";
  let w = 0;
  let i = 0;
  while (i < s.length && w < cols) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += s[i];
    w++;
    i++;
  }
  return out + RS;
}

// ---- key decoding (shared raw-stdin reader) ----

export type Key =
  | { t: "char"; s: string }
  | { t: "enter" }
  | { t: "tab" }
  | { t: "backspace" }
  | { t: "left" }
  | { t: "right" }
  | { t: "up" }
  | { t: "down" }
  | { t: "home" }
  | { t: "end" }
  | { t: "esc" }
  | { t: "ctrlc" };

export function decodeKeys(s: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\x03") { keys.push({ t: "ctrlc" }); i++; continue; }
    if (c === "\r" || c === "\n") { keys.push({ t: "enter" }); i++; continue; }
    if (c === "\t") { keys.push({ t: "tab" }); i++; continue; }
    if (c === "\x7f" || c === "\b") { keys.push({ t: "backspace" }); i++; continue; }
    if (c === "\x1b") {
      const rest = s.slice(i);
      if (rest.startsWith("\x1b[A")) { keys.push({ t: "up" }); i += 3; continue; }
      if (rest.startsWith("\x1b[B")) { keys.push({ t: "down" }); i += 3; continue; }
      if (rest.startsWith("\x1b[C")) { keys.push({ t: "right" }); i += 3; continue; }
      if (rest.startsWith("\x1b[D")) { keys.push({ t: "left" }); i += 3; continue; }
      if (rest.startsWith("\x1b[H") || rest.startsWith("\x1b[1~")) { keys.push({ t: "home" }); i += rest.startsWith("\x1b[H") ? 3 : 4; continue; }
      if (rest.startsWith("\x1b[F") || rest.startsWith("\x1b[4~")) { keys.push({ t: "end" }); i += rest.startsWith("\x1b[F") ? 3 : 4; continue; }
      if (rest.length === 1 || rest[1] !== "[") { keys.push({ t: "esc" }); i++; continue; }
      const m = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(rest);
      i += m ? m[0].length : 1;
      continue;
    }
    keys.push({ t: "char", s: c });
    i++;
  }
  return keys;
}
