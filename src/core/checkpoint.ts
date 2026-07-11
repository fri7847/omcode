// File checkpoints — Cline-style per-turn snapshots without git machinery.
// Before edit/write mutates a file, the previous content is captured once per
// turn; /undo restores the whole turn's changes.

import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

interface Snapshot {
  path: string;
  /** null = file did not exist before (undo deletes it) */
  before: string | null;
}

export class CheckpointStore {
  private turns: Snapshot[][] = [];
  private current: Snapshot[] | null = null;

  beginTurn(): void {
    this.current = [];
    this.turns.push(this.current);
    if (this.turns.length > 20) this.turns.shift();
  }

  /** Capture a file's pre-mutation state (once per path per turn). */
  async snapshot(absPath: string): Promise<void> {
    if (!this.current) return;
    if (this.current.some((s) => s.path === absPath)) return;
    let before: string | null;
    try {
      before = await readFile(absPath, "utf8");
    } catch {
      before = null;
    }
    this.current.push({ path: absPath, before });
  }

  /** For each file mutated this session, its earliest pre-change content — the
   * session-original state, so /diff can show original→current for the whole run. */
  originals(): { path: string; before: string | null }[] {
    const seen = new Map<string, string | null>();
    for (const turn of this.turns) {
      // turns are oldest→newest, so the first time we see a path is its origin
      for (const snap of turn) if (!seen.has(snap.path)) seen.set(snap.path, snap.before);
    }
    return [...seen].map(([path, before]) => ({ path, before }));
  }

  /** Undo the most recent turn that changed files. Returns restored paths. */
  async undoLastTurn(): Promise<string[]> {
    while (this.turns.length > 0) {
      const turn = this.turns.pop()!;
      if (turn.length === 0) continue;
      const restored: string[] = [];
      for (const snap of turn.reverse()) {
        try {
          if (snap.before === null) {
            await unlink(snap.path);
          } else {
            await mkdir(dirname(snap.path), { recursive: true });
            await writeFile(snap.path, snap.before, "utf8");
          }
          restored.push(snap.path);
        } catch {
          // keep restoring the rest
        }
      }
      this.current = null;
      return restored;
    }
    return [];
  }
}
