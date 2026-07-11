# Contributing to OMcode

Thanks for your interest. OMcode is a small, dependency-light coding-agent harness for open models. Contributions that keep it that way are very welcome.

## The one rule that shapes everything

**Absorb the model's mistakes with the fewest possible tokens.** Recovery is ordered by cost: absorb in harness code (0 tokens) → one corrective retry → format demotion (`edit`→`write`) → hard stop. Never add retry-bomb loops. If a change makes the harness spend more tokens to handle a model failure, it's probably going the wrong way.

## Development

Requires Node.js 20+.

```bash
npm install
npm run typecheck    # must pass
npm test             # harness unit tests — run without a model
npx tsx test/smoke.ts <model>   # one live turn against a model
npx tsx eval/run.ts <model>     # mini edit benchmark (pass@1 / edit-apply / tokens)
```

CI runs `typecheck` + `test` on every push and PR.

## Where things live

See [`AGENTS.md`](./AGENTS.md) for the architecture map. The three modules that carry the thesis — and that must ship with tests when changed — are:

- `src/model/io-guard.ts` — recover malformed tool calls, classify empty turns, strip `<think>`, catch degenerate output.
- `src/tools/applier.ts` — the fuzzy `SEARCH/REPLACE` applier.
- `src/policy/loop-breaker.ts` — nudge on repeat, halt on loop.

## Conventions

- **Keep it dependency-light.** Current runtime deps are only `zod` + `fast-glob`. Adding a dependency needs a strong justification.
- **TypeScript strict**, `noUncheckedIndexedAccess`. `npm run typecheck` must be clean.
- **Error messages returned to the model are self-correction guides** — say what's wrong *and* how to fix it, so a weak model recovers in one retry instead of looping.
- **Core is UI-free.** It emits through the `LoopUI` event interface; it never writes to stdout. New frontends implement `LoopUI`.
- **No secrets in the repo.** Keys come from env or `~/.omcode/config.json` (outside the tree).
- **Buffer-then-parse** for tool calls — streamed deltas are a preview; the buffered response is authoritative.

## Pull requests

- Keep changes surgical and focused on one thing.
- New behavior in io-guard / applier / loop-breaker needs a unit test.
- `npm run typecheck` and `npm test` pass locally before you open the PR.

## Adding support for a model or language

- **A new model family** that behaves differently at the harness boundary (thinking, tool-call reliability): add an entry to `src/model/profiles.ts` with a `think` default and, if the model is a weaker tool-caller, a short `systemAddendum`.
- **A new language for post-edit diagnostics**: extend `src/tools/diagnostics.ts` (`projectDiagnostics`) — detect the project marker, run the non-emitting checker, and gate it on the toolchain being installed (a missing tool must be skipped, never an error).
