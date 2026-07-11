# OMcode

A Claude Code–style coding-agent harness for **open models** (Ollama local & Ollama Cloud, or any OpenAI-compatible endpoint).

> **Thesis:** *absorb the model's mistakes with the fewest possible tokens.*
> Open models aren't RL-trained for your harness, so they mis-format tool calls, botch edits, and loop. OMcode's job is to catch those failures in harness code — ideally at zero extra token cost — before spending a retry.

Status: **early / experimental.** Built and validated primarily against `qwen3-coder:480b` (Ollama Cloud) and `qwen3:8b` (local).

## Why

Every open-model harness fails first at the same three places. OMcode is built around defending them:

1. **The model I/O boundary** — streaming tool-call chunk loss, malformed XML/JSON tool calls, "empty response" misclassification. → `io-guard` recovers tool calls from text, classifies empty turns correctly, strips `<think>` leakage, and enforces `num_ctx` (a silently-truncated context window collapses quality).
2. **Edit reliability** — half of it lives in the applier, not the prompt. → a fuzzy `SEARCH/REPLACE` applier: exact → whitespace-normalized → Levenshtein match, with a `startLine` hint and middle-out search. On failure it returns a **self-correction guide** (the closest real content + similarity) so a weak model can fix it in one retry instead of looping.
3. **Loops** — detection has to actually *intervene*. → identical call twice → a nudge; three times → the turn is stopped before it burns your context and budget.

Recovery is ordered by token cost: **absorb in harness code (0 tokens) → one corrective retry → format demotion (`edit`→`write`) → hard stop.**

## Features

- Minimal agent loop (`while tool_call`), append-only JSONL sessions, resume
- Tools: `read` `glob` `grep` `repo_map` `task` `edit` `write` `typecheck` `shell`
- Architect/editor separation: architect mode is enforced read-only; isolated `task` scouts return only a compact report
- Post-edit TypeScript diagnostics: clean checks add no context; failures are returned to the editor automatically
- Permissions (allow / ask / deny), `.git/` writes blocked, per-session "always allow"
- Context compaction: snip old tool results (0 tokens) → LLM condense (keeps recent turns verbatim)
- Checkpoints + `/undo`
- Fixed-chrome terminal UI: fixed header/status/input, scrolling output, live streaming, inline diff shown inside the approval prompt, arrow-key selection, esc-to-interrupt
- A mini edit benchmark (`eval/`) reporting pass@1 / pass@2 / **edit-apply rate** / tokens-per-success

## Install

Requires Node.js 20+ and [Ollama](https://ollama.com) (local) or an Ollama Cloud API key.

```bash
git clone https://github.com/<you>/omcode
cd omcode
npm install
npm link          # registers the global `omcode` command
```

## Usage

```bash
omcode                 # start a session
omcode --resume        # resume the latest session
omcode --resume list   # pick a past session
```

Configuration lives in `~/.omcode/config.json` (host / model / apiKey / numCtx). Environment variables override it: `OMCODE_HOST`, `OMCODE_MODEL`, `OMCODE_NUM_CTX`, `OMCODE_CONDENSE_MODEL`, `OMCODE_MODE`, `OLLAMA_API_KEY`.

```jsonc
{
  "host": "https://ollama.com",   // or http://localhost:11434
  "model": "qwen3-coder:480b",
  "numCtx": 32768,
  "stream": true,
  "mode": "editor",
  "condenseModel": "qwen3:8b"
}
```

In-session: `/model` (switch model), `/mode architect|editor`, `/undo`, `/help`, `/exit`. During a turn, `esc` interrupts.

> **Hardware note:** on an 8 GB GPU (e.g. RTX 3070 Ti), an 8B model at `num_ctx=8192` is the practical local sweet spot; larger contexts spill to CPU and slow to a crawl. On local NVIDIA hosts OMcode probes VRAM and warns about unsafe context settings without overriding an explicit setting. For serious work, use Ollama Cloud.

## Development

```bash
npm run typecheck
npm test               # harness unit tests (no model needed)
npx tsx eval/run.ts <model>   # mini edit benchmark against a live model
```

Contributions welcome — the harness core (`src/core`, `src/model`, `src/tools`) is deliberately small and dependency-light. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`AGENTS.md`](./AGENTS.md).

## License

[Apache-2.0](./LICENSE)
