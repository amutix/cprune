# cprune Pi extension

Context pruning extension for Pi. It reduces duplicate, append-only, stale, and oversized context before model calls, and can optionally trigger focused compaction.

Append/contained pruning detects exact byte prefixes, normalized line-prefixes, and substantial normalized contained blocks, so it can catch repeated output with new lines appended even when ANSI escapes, CRLF/LF, trailing whitespace, or small wrappers differ. Older repeated read-only snapshot commands such as `rg`, `find`, `ls`, and `git status` are also pruned when the same command is run again later.

## Use

From this directory:

```bash
pi -e ./src/cprune.ts
```

Or install/configure it as a Pi package; `package.json` exposes `src/cprune.ts` under the `pi.extensions` field.

## Commands

```text
/cprune status        Show cumulative pruning counters
/cprune context-stat  Compare raw context vs simulated cprune-pruned context
/cprune on            Enable pruning
/cprune off           Disable pruning
/cprune compact       Trigger cprune-focused compaction
```

## Tool

cprune also registers an LLM-callable tool named `cprune_status` with actions:

```text
status        Show cumulative pruning counters
context-stat  Compare raw context vs simulated cprune-pruned context
on            Enable pruning
off           Disable pruning
compact       Trigger cprune-focused compaction
```

`/cprune context-stat` and `cprune_status action="context-stat"` work whether pruning is on or off, so you can compare estimated savings before enabling it. The output includes grouped sections and terminal bar charts for raw vs pruned context plus per-rule hit counts.

Note: turning pruning off prevents future pruning. It does not reconstruct tool outputs that were already pruned before persistence.
