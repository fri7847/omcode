// Append-only JSONL session log (Claude Code / OpenHands lesson: an immutable
// event log gives resume, replay, and audit for free). Phase 0 writes only;
// resume comes in Phase 2.

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type { ChatMessage, ToolCall } from "../model/provider.js";

export interface SessionEvent {
  ts: string;
  type: string;
  [k: string]: unknown;
}

export function defaultSessionDir(): string {
  return join(os.homedir(), ".omcode", "sessions");
}

/** Most recent session file in the default dir, or undefined. */
export function latestSessionFile(): string | undefined {
  return listSessions(1)[0]?.file;
}

export interface SessionSummary {
  file: string;
  /** timestamp parsed from the filename */
  startedAt: string;
  /** first user message, for preview */
  firstUser: string;
  messages: number;
}

/**
 * Recent sessions, newest first. Sessions without any user message
 * (aborted starts, harness self-tests) are skipped.
 */
export function listSessions(limit = 10, dir = defaultSessionDir()): SessionSummary[] {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const f of files) {
    if (out.length >= limit) break;
    const file = join(dir, f);
    let firstUser = "";
    let messages = 0;
    try {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let ev: SessionEvent;
        try {
          ev = JSON.parse(line) as SessionEvent;
        } catch {
          continue;
        }
        if (["system", "user", "assistant", "tool"].includes(ev.type)) messages++;
        if (!firstUser && ev.type === "user") firstUser = String(ev["content"] ?? "");
      }
    } catch {
      continue;
    }
    if (!firstUser) continue; // nothing to resume
    // filename: 2026-07-11T07-01-43-123Z.jsonl → readable stamp
    const stamp = f.replace(".jsonl", "").replace(/T(\d{2})-(\d{2})-(\d{2}).*/, " $1:$2:$3");
    out.push({ file, startedAt: stamp, firstUser, messages });
  }
  return out;
}

/**
 * Rebuild the message history from an append-only session log.
 * The log IS the state — no separate checkpoint format (OpenHands lesson).
 */
export function loadMessages(file: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const raw = readFileSync(file, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: SessionEvent;
    try {
      ev = JSON.parse(line) as SessionEvent;
    } catch {
      continue; // a torn last line must not block resume
    }
    switch (ev.type) {
      case "system":
        messages.push({ role: "system", content: String(ev["content"] ?? "") });
        break;
      case "user":
        messages.push({ role: "user", content: String(ev["content"] ?? "") });
        break;
      case "assistant": {
        const calls = (ev["toolCalls"] as ToolCall[] | undefined) ?? [];
        messages.push({
          role: "assistant",
          content: String(ev["content"] ?? ""),
          toolCalls: calls.length ? calls : undefined,
        });
        break;
      }
      case "tool":
        messages.push({
          role: "tool",
          content: String(ev["result"] ?? ""),
          toolName: String(ev["name"] ?? ""),
        });
        break;
      case "cleared":
        // /clear reset the conversation — drop everything but the system prompt
        messages.splice(1);
        break;
      default:
        break;
    }
  }
  return messages;
}

export class SessionLog {
  readonly file: string;

  constructor(baseDir?: string) {
    const dir = baseDir ?? join(os.homedir(), ".omcode", "sessions");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.file = join(dir, `${stamp}.jsonl`);
  }

  append(type: string, data: Record<string, unknown> = {}): void {
    const event: SessionEvent = { ts: new Date().toISOString(), type, ...data };
    try {
      appendFileSync(this.file, JSON.stringify(event) + "\n", "utf8");
    } catch {
      // Logging must never break the loop.
    }
  }
}
