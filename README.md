# cprune Pi extension

Context pruning extension for Pi. It reduces duplicate, append-only, stale, and oversized context before model calls, and can optionally trigger focused compaction.

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

`/cprune context-stat` works whether pruning is on or off, so you can compare estimated savings before enabling it.

Note: turning pruning off prevents future pruning. It does not reconstruct tool outputs that were already pruned before persistence.
