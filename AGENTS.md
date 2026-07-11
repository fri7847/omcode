# AGENTS.md

Guidance for coding agents (Codex, Claude Code, etc.) and human contributors working on **OMcode**.

## What this project is

A Claude Code–style coding-agent harness for **open models** (Ollama local / Ollama Cloud / any OpenAI-compatible endpoint). TypeScript, dependency-light.

**Core thesis — keep every change aligned with it:** *absorb the model's mistakes with the fewest possible tokens.* Open models mis-format tool calls, botch edits, and loop. The harness's job is to catch those in code — ideally at zero token cost — before spending a retry. Recovery is ordered by cost: **absorb in harness code (0 tokens) → one corrective retry → format demotion (`edit`→`write`) → hard stop.** Never add retry-bomb loops.

## Architecture map

```
src/
├── core/        agent loop, JSONL session (+resume), context compaction, checkpoints/undo
├── model/       provider interface, Ollama client (streaming + num_ctx + abort),
│                io-guard (tool-call recovery, empty-turn classification, <think> strip,
│                degenerate-output detection)
├── tools/       registry (uniform Tool interface) + read/glob/grep/edit/write/shell,
│                fuzzy SEARCH/REPLACE applier, fs-guard (blocks .git/ and out-of-tree writes)
├── policy/      loop-breaker (nudge on repeat, halt on loop)
├── prompt/      system prompt (kept short — open models lose buried instructions)
└── cli/         repl (inline path), interactive (fixed-chrome TUI), render, diff, config, screen
eval/            mini edit benchmark: pass@1 / pass@2 / edit-apply rate / tokens-per-success
test/            harness unit tests (run without a model) + live smoke/e2e
```

The three modules that carry the thesis: **`model/io-guard.ts`**, **`tools/applier.ts`**, **`policy/loop-breaker.ts`**. Changes there need tests.

## Conventions

- **Keep the core small and dependency-light** (currently only `zod` + `fast-glob`). Don't add a dependency without a strong reason.
- **TypeScript strict** with `noUncheckedIndexedAccess`. `npm run typecheck` must pass.
- **Error messages returned to the model are self-correction guides** — say what's wrong AND how to fix it, so a weak model recovers in one retry instead of looping.
- **The UI is decoupled from core** via the `LoopUI` event interface — core never writes to stdout. New frontends implement `LoopUI`.
- **No secrets in the repo.** API keys come from env or `~/.omcode/config.json` (outside the tree). Never hardcode or commit a key.
- **Buffer-then-parse** for tool calls — streamed deltas are a preview only; the buffered response is authoritative.

## Dev commands

```bash
npm install
npm run typecheck
npm test                        # unit tests, no model needed
npx tsx test/smoke.ts <model>   # one-turn live smoke test
npx tsx eval/run.ts <model>     # mini edit benchmark against a live model
npm link                        # register the global `omcode` command
```

## Before you commit

- `npm run typecheck` and `npm test` pass.
- New behavior in io-guard / applier / loop-breaker has a unit test.
- No secret material added.
