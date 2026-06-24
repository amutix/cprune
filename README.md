# cprune Pi extension

Context pruning extension for Pi. It reduces duplicate, append-only, stale, and oversized context before model calls. It can also request Pi's supported persistent compaction mechanism when you explicitly want a lossy summary.

Append/contained pruning detects exact byte prefixes, normalized line-prefixes, substantial normalized contained blocks, and repeated line chunks, so it can catch repeated output with new lines appended even when ANSI escapes, CRLF/LF, trailing whitespace, small wrappers, or some middle insertions differ. Older repeated read-only snapshot commands such as `rg`, `find`, `ls`, and `git status` are also pruned when the same command is run again later. Old custom extension messages are deduped/truncated generically, structured entity notifications are compacted when superseded, and boilerplate “run/show for full context” tails are stripped without hardcoding one extension.

Entity-aware pruning is generic rather than tied to one extension: it detects IDs like `TASK-123`, `SPEC-12`, `DISC-3`, `ISSUE-9`, `PR-42`, etc., then applies a latest-entity-snapshot-wins policy across older user messages, custom extension messages, tool results, assistant text, and summaries while preserving IDs, hashes, and short previews. Old successful assistant tool calls can be compacted to tool name, IDs/paths, hash, and preview, so large prior spec/comment bodies do not remain in request context. Non-core tool results with the same tool+entity are also superseded by newer successful results. Stats include entity-family counts/savings such as `TASK-*`, `SPEC-*`, and `DISC-*`.

## Safety and information loss

cprune has two pruning points:

- **Persist-time pruning** runs on new tool results before Pi stores them. This is intentionally conservative and limited to mechanical cases: exact duplicates, normalized duplicates where only ANSI/CRLF/trailing whitespace differ, append/prefix repeats, and oversized tool results with hash/original-size metadata plus retained head/tail preview.
- **Prompt-time pruning** runs before a model request. It is non-destructive to Pi's active session files, but can be more aggressive because it only changes the context sent to the model for that request. `/cprune review` adds explicit user-approved prompt-time exclusions for large older entries; `/cprune review-command [N]` lets you exclude a selected prompt/response turn from the last N user prompts. These exclusions are persisted as cprune state, not by rewriting Pi history.

cprune should not be described as fully lossless. Persist-time pruning is near-lossless but still replaces bytes in saved tool results for the safe cases above. Prompt-time pruning may replace older details with hashes, IDs, previews, and re-run hints. This reduces token use, but the model may no longer see every historical byte in the immediate request.

Risk levels:

- Low risk / near-lossless: exact duplicates, normalized duplicates, exact append/prefix repeats, and repeated chunks where a newer full copy remains.
- Medium risk: stale file-read pruning, superseded entity/tool-result pruning, structured notice compaction, and historical tool-call argument compaction.
- Explicitly lossy: old assistant thinking removal, latest-entity-snapshot-wins summaries, and `/cprune compact`.

Recommended wording: cprune uses **conservative near-lossless persist-time pruning** plus **non-destructive but lossy-at-prompt-time pruning**. It preserves recent context, errors, entity IDs, hashes, previews, and re-run hints, but it may remove historical details from saved tool results in safe mechanical cases and from the model request in broader prompt-time cases.

## Use

From this directory:

```bash
pi -e ./src/cprune.ts
```

Or install/configure it as a Pi package; `package.json` exposes `src/cprune.ts` under the `pi.extensions` field.

## Commands

```text
/cprune status             Show cumulative pruning counters
/cprune stats              Compare raw context vs simulated cprune-pruned context
/cprune review             Pick large older context entries to exclude from future prompts
/cprune review-command [N] [page] Pick a prompt/response turn from history (default last 10, page 1)
/cprune clear-exclusions   Clear user-approved prompt-time exclusions
/cprune on                 Enable pruning
/cprune off                Disable pruning
/cprune compact            Lossily compact/prune context via Pi compaction
```

## Tool

cprune also registers an LLM-callable tool named `cprune_status` with actions:

```text
status        Show cumulative pruning counters
stats         Compare raw context vs simulated cprune-pruned context
on            Enable pruning
off           Disable pruning
compact       Lossily compact/prune context via Pi compaction
```

`/cprune stats` and `cprune_status action="stats"` work whether pruning is on or off, so you can compare estimated savings before enabling it. (`stat` and the old `context-stat` action are accepted as aliases.) The output includes grouped sections, orange/green continuous bars, before/after breakdown by context part, per-rule hit counts, per-rule character savings, and any user-approved exclusions.

`/cprune review-command [N] [page]` is useful after accidentally pushing a noisy prompt/response/tool-output turn into context. It reviews raw branch history, excludes the selected turn from future prompts when that turn appears in model context, and does not delete the underlying Pi session entries. Results are paginated; if the select UI cannot reach navigation options, jump directly with e.g. `/cprune review-command 50 2`.

Note: `/cprune compact` is intentionally named compact because it is lossy summarization. It does not rewrite Pi session JSONL files in place; it uses Pi's compaction API to append a normal compaction entry, which is safer for Pi's append-only session/tree model. Turning pruning off prevents future pruning; it does not reconstruct tool outputs that were already pruned before persistence.
