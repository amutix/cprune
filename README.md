# cprune

**cprune is a Pi extension that trims noisy agent context before model calls.**

It reduces repeated tool output, append-only logs, stale read-only snapshots, oversized results, old assistant thinking, and selected historical prompt turns so long Pi sessions stay cheaper and easier for the model to use.

It is designed for agentic coding sessions where the same information often appears many times: repeated `rg`/`find`/`ls` output, growing command logs, duplicated task/spec notifications, long tool results, and old reasoning blocks.

## What you get

- **Lower prompt size** without manually compacting every session.
- **A clear `/cprune` report** comparing `off`, `safe`, and `full` modes.
- **Real cache stats** from the provider response (`cacheRead`), not guessed cache predictions.
- **Cost estimates** for this turn and the whole session.
- **User review commands** for explicitly excluding noisy old context.
- **Deterministic lossy compaction** when a session is too large for normal model summarization.

## Example output

```text
cprune

   mode: full  ·  gpt-5.5 via openai-codex  ·  51284/272000 tok (18.9%)
   last turn: 98.2% cache hit  ·  922 tok new  ·  $0.0353

   off   ████████████████████████ 39,393 tok
   safe  ███████████████████████▏ 37,893 tok   −1,500  <$0.01
   full  █████████████████▋       28,897 tok   −10,496  $0.0525

   est. saved last turn : 10,496 tok  ·  $0.0525
   est. saved session   : $5.48

   ...breakdown by context part...

   Cache model: prefix-cache (change invalidates the tail — full mode freezes its prefix)
```

Interpretation:

- `off` is the raw prompt size with no cprune prompt-time pruning.
- `safe` is the prompt size if safe mode were applied now.
- `full` is the effective full-mode prompt size. On prefix-cache providers this includes the active frozen prefix, because that is what cprune actually sends to preserve cache stability.
- `last turn` is the **actual provider-reported cache behavior** from the previous model call.
- `est. saved last turn` is the actual prompt-token delta captured for the model call that produced the last response, priced with real billing data when available or clearly labeled assumed pricing otherwise.
- Because active `full` may keep an old prefix frozen, it can occasionally show less immediate savings than `safe`; that is a cache-preservation tradeoff, not a cache prediction.

## Install

```bash
pi install git:github.com/amutix/cprune
```

Or run from a checkout:

```bash
pi -e ./src/cprune.ts
```

## Commands

```text
/cprune                    Show off/safe/full comparison
/cprune safe               Enable conservative pruning
/cprune full               Enable aggressive pruning (`on` is an alias)
/cprune off                Disable pruning
/cprune review             Pick large older entries to exclude from future prompts
/cprune review-prompts     Pick an old prompt/response turn to exclude
/cprune clear-exclusions   Clear user-approved exclusions
/cprune compact            Add a lossy deterministic compaction summary
```

cprune also registers an LLM-callable tool named `cprune_status` with actions `safe`, `full`, `off`, and `compact`.

New sessions default to `safe`. Existing sessions keep their persisted mode.

## Modes

### `off`

No future pruning is applied. `/cprune` still simulates `safe` and `full` so you can see what would be saved.

### `safe`

Default/recommended mode. Conservative mode focuses on mechanical duplication and size reduction:

- exact duplicate tool results
- normalized duplicates where only ANSI/CRLF/trailing whitespace differ
- append-only repeats where a previous output is contained in a newer one
- repeated line chunks
- oversized tool-result truncation with hash/original-size metadata
- explicit user-approved exclusions from `/cprune review*`

Safe mode avoids semantic/latest-wins rules such as stale reads, entity supersession, old thinking removal, and historical tool-call argument compaction.

### `full`

Aggressive opt-in mode. Includes safe-mode rules plus higher-savings prompt-time pruning:

- stale read-only snapshot pruning (`rg`, `find`, `ls`, `git status`, etc.)
- superseded custom/entity/tool-result snapshots
- old assistant thinking removal
- historical tool-call argument compaction for safe tool calls
- structured notice compaction

User messages are **not** semantically compacted automatically. You can still explicitly exclude selected old user/prompt turns with review commands.

## How it works

cprune has two pruning points:

### 1. Persist-time pruning

Runs when new tool results arrive, before Pi stores them. This is deliberately conservative. It only rewrites saved tool results for near-mechanical cases such as duplicates, append repeats, and oversized outputs.

It preserves:

- failed/error diagnostics
- mutation outputs
- side-effectful shell commands
- browser/API/auth/payment/deploy-style results
- edit/write/apply-patch arguments and outputs
- sensitive nested `multi_tool_use.parallel` calls

### 2. Prompt-time pruning

Runs right before a model request. It does **not** rewrite Pi history; it only changes the message array sent to the model for that call.

Prompt-time pruning can be more aggressive in `full` mode because the original session entries remain in Pi history. Replacements include hashes, IDs, previews, original sizes, and re-run hints where useful.

## Cache behavior

Prompt caching can make long sessions cheap when consecutive requests share a stable prefix. A context pruner can accidentally ruin that by changing old messages every turn.

cprune handles this carefully:

- On **prefix-cache providers** such as OpenAI/gpt and Anthropic-style APIs, active `full` mode freezes the already-sent prefix. Only the new tail is aggressively pruned. This preserves prompt-cache stability. The frozen prefix is in-memory; after a process reload it re-establishes after one model turn rather than being persisted as a huge prompt copy.
- On **content-cache providers** such as zai/glm gateways, `full` mode stays fully aggressive because those providers can reuse unchanged blocks even after a prefix change.

`/cprune` does **not** predict cache hit rates. Prediction turned out to be less reliable than the APIs themselves. Instead, cprune reports the real last-turn cache hit from provider usage data.

## Safety model

cprune is not magic lossless compression.

- **Near-lossless:** exact duplicates, normalized duplicates, append repeats, repeated chunks where a newer full copy remains.
- **Conservative lossy:** oversized persisted tool results keep head/tail, original size, and hash.
- **Prompt-only lossy:** full-mode stale/superseded historical context may be replaced with compact summaries, IDs, hashes, and previews.
- **Explicitly lossy:** `/cprune compact` creates a persistent summary entry.

Turning cprune off stops future pruning. It does not reconstruct tool results that were already pruned before persistence.

## Manual review commands

```text
/cprune review
```

Shows large older context entries and lets you exclude selected ones from future prompts. Pi history is not deleted.

```text
/cprune review-prompts [safe|full] [N] [page]
```

Shows historical prompt/response turns and lets you exclude selected noisy turns. Useful after accidentally dumping huge output into the conversation.

Examples:

```text
/cprune review-prompts safe 50 2
/cprune review-prompts full 50
```

## Compaction

```text
/cprune compact
```

Adds a deterministic cprune summary through Pi's supported compaction hook. It is intentionally called **compact** because it is lossy.

This is useful when a session is so large that normal model-based summarization would itself exceed the context window. cprune does not rewrite Pi JSONL files in place; it appends a normal compaction entry.

## What cprune does not do

- It does not change model weights or retrieval behavior.
- It does not promise fully lossless compression.
- It does not delete Pi session history for prompt-time pruning.
- It does not predict cache hits for modes you did not run.
- It does not preserve every old byte in the immediate model request when `full` mode or compaction is used.

## When should I use it?

Use cprune if you run long Pi coding sessions with lots of repeated tool output or extension state.

Recommended default:

- Start with **`safe`** for stable day-to-day use.
- Use **`full`** only when you explicitly want aggressive prompt-time pruning and accept that it rewrites more historical context sent to the model.
- Use **`off`** when investigating whether pruning affects a specific behavior.

Run `/cprune` any time to see what it is doing.

## License

MIT
