# cprune Pi extension

Context pruning extension for Pi. It reduces duplicate, append-only, stale, and oversized context before model calls, and can optionally trigger focused compaction.

Append/contained pruning detects exact byte prefixes, normalized line-prefixes, substantial normalized contained blocks, and repeated line chunks, so it can catch repeated output with new lines appended even when ANSI escapes, CRLF/LF, trailing whitespace, small wrappers, or some middle insertions differ. Older repeated read-only snapshot commands such as `rg`, `find`, `ls`, and `git status` are also pruned when the same command is run again later. Old custom extension messages are deduped/truncated generically without hardcoding any extension names.

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
/cprune compact       Trigger cprune-focused compaction
```

## Tool

cprune also registers an LLM-callable tool named `cprune_status` with actions:

```text
status        Show cumulative pruning counters
stats         Compare raw context vs simulated cprune-pruned context
on            Enable pruning
off           Disable pruning
compact       Trigger cprune-focused compaction
```

`/cprune stats` and `cprune_status action="stats"` work whether pruning is on or off, so you can compare estimated savings before enabling it. (`stat` and the old `context-stat` action are accepted as aliases.) The output includes grouped sections, ANSI-colored orange before / green after continuous bars, before/after breakdown by context part, per-rule hit counts, and per-rule character savings.

Note: turning pruning off prevents future pruning. It does not reconstruct tool outputs that were already pruned before persistence.
