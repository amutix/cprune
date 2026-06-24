# cprune Pi extension

Context pruning extension for Pi. It reduces duplicate, append-only, stale, and oversized context before model calls. It can also `apply` pruning by requesting Pi's supported persistent compaction mechanism.

Append/contained pruning detects exact byte prefixes, normalized line-prefixes, substantial normalized contained blocks, and repeated line chunks, so it can catch repeated output with new lines appended even when ANSI escapes, CRLF/LF, trailing whitespace, small wrappers, or some middle insertions differ. Older repeated read-only snapshot commands such as `rg`, `find`, `ls`, and `git status` are also pruned when the same command is run again later. Old custom extension messages are deduped/truncated generically without hardcoding any extension names.

Entity-aware pruning is generic rather than tied to one extension: it detects IDs like `TASK-123`, `SPEC-12`, `DISC-3`, `ISSUE-9`, `PR-42`, etc., then applies a latest-entity-snapshot-wins policy across older user messages, custom extension messages, tool results, assistant text, and summaries while preserving IDs, hashes, and short previews. Old successful assistant tool calls also have oversized string arguments replaced with hash+preview placeholders so large prior spec/comment bodies do not remain in request context. Stats include entity-family counts/savings such as `TASK-*`, `SPEC-*`, and `DISC-*`.

## Use

From this directory:

```bash
pi -e ./src/cprune.ts
```

Or install/configure it as a Pi package; `package.json` exposes `src/cprune.ts` under the `pi.extensions` field.

## Commands

```text
/cprune status        Show cumulative pruning counters
/cprune stats         Compare raw context vs simulated cprune-pruned context
/cprune on            Enable pruning
/cprune off           Disable pruning
/cprune apply         Apply pruning persistently via Pi compaction
/cprune compact       Alias for apply
```

## Tool

cprune also registers an LLM-callable tool named `cprune_status` with actions:

```text
status        Show cumulative pruning counters
stats         Compare raw context vs simulated cprune-pruned context
on            Enable pruning
off           Disable pruning
apply         Apply pruning persistently via Pi compaction
compact       Alias for apply
```

`/cprune stats` and `cprune_status action="stats"` work whether pruning is on or off, so you can compare estimated savings before enabling it. (`stat` and the old `context-stat` action are accepted as aliases.) The output includes grouped sections, orange/green continuous bars, before/after breakdown by context part, per-rule hit counts, and per-rule character savings.

Note: `/cprune apply` does not rewrite Pi session JSONL files in place. It uses Pi's compaction API to append a normal compaction entry, which is safer for Pi's append-only session/tree model. Turning pruning off prevents future pruning; it does not reconstruct tool outputs that were already pruned before persistence.
