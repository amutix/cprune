# Changelog

## v0.2.6 - 2026-06-30

### Fixed
- **Provider-aware cache prediction.** v0.2.5 assumed all providers cache by content/block reuse, which made the predictor dangerously optimistic on OpenAI/gpt and Anthropic (they cache by strict prefix). Measured reality confirmed this: the same `full`-mode prefix break produced a **98%** cache hit on a zai/glm gateway but only **8%** on gpt-5.5 (~5× cost). The predictor now detects the provider's cache model from the response's `api`/`provider` and headlines the matching model:
  - OpenAI/codex/anthropic/bedrock/google and OpenAI-compatible routers (deepseek, groq, xai, mistral, …) → strict-prefix model.
  - zai/glm gateways → content/block-reuse model.
  - unknown → conservative strict-prefix, with a hint to compare against the actual reading.
- Added an inline recommendation: when `full` mode costs ≥1.3× of `off` on a prefix-sensitive provider, `/cprune` suggests `/cprune safe`.
- Actual usage line now shows the provider slug.

## v0.2.5 - 2026-06-30

### Fixed
- Cache-impact predictor now uses a **content-aware model** instead of brittle strict-prefix matching. Previously a single changed message invalidated the whole tail (~9× overestimate of cache misses). Real providers cache by block/content, so unchanged messages after the prefix break are re-served from cache. The predictor now matches measured reality (e.g. predicted 98% hit vs actual 98%).
- Relabeled the divergence marker from `break@` to `first-change@` and clarified that `read%` includes content reuse.

## v0.2.4 - 2026-06-30

### Added
- Cache-impact analysis in `/cprune`: predicts per-mode prompt-cache hit rate and relative cost vs the previous turn, with **no extra LLM calls**. Uses an offline prefix-match model (cached reads ~0.1x, misses/cache-writes ~1.25x) to expose the cache penalty of `full` vs `safe` vs `off`.
- Reads real provider usage from assistant messages (`input`, `cacheRead`, `cacheWrite`, `output`, `cost`) and surfaces actual cache-hit % in the comparison view.

## v0.2.3 - 2026-06-26

### Fixed
- Added preserve guards for tool outputs and tool-call arguments that should not be omitted automatically: failed/error results, diagnostic failures, side-effectful shell commands, mutation tools, and non-repeatable browser/API-style tools.
- This keeps cprune focused on mechanical waste while avoiding loss of state-changing, error-bearing, or hard-to-reproduce context.

## v0.2.2 - 2026-06-26

### Fixed
- Preserve historical `edit`/`write` tool-call arguments, including wrapped `multi_tool_use.parallel` edit/write calls. cprune no longer replaces exact `oldText`/`newText` mutation arguments with placeholders, avoiding corrupted follow-up edit context and noisy diffs.

## v0.2.1 - 2026-06-26

### Fixed

- `/cprune compact` now provides a deterministic cprune summary through Pi's `session_before_compact` hook instead of asking the model to summarize the raw oversized session. This avoids `context_length_exceeded` failures when the normal Pi summarization request is already too large.
- cprune compaction still uses Pi's supported compaction entry mechanism and remains lossy, but it no longer depends on fitting the full raw compaction input into the model context window.

## v0.2.0 - 2026-06-24

First public release candidate for cprune as a Pi context-pruning extension.

### Added

- Global pruning modes: `off`, `safe`, and `full`.
- Compact `/cprune` report comparing off/safe/full context sizes with red/orange/green bars.
- Conservative persist-time pruning for duplicate, normalized-duplicate, append/repeated-prefix, and oversized tool results.
- Prompt-time pruning for duplicate/append outputs, repeated line chunks, stale reads, entity/latest-wins snapshots, historical tool-call arguments, oversized old results, structured notices, and user-approved exclusions.
- `/cprune review` for excluding selected large older context entries from future prompts.
- `/cprune review-prompts [safe|full] [N] [page]` for excluding selected prompt/response turns.
- `/cprune compact` for explicit lossy Pi compaction.
- LLM-callable `cprune_status` tool for mode changes, compact requests, and off/safe/full comparison.

### Changed

- `/cprune` with no subcommand is now the primary status/statistics view.
- Removed separate `/cprune status` and `/cprune stats` commands to keep the UI simpler.
- Simplified the report by removing noisy rule/entity-family detail sections.

### Safety notes

- cprune does not rewrite active Pi session JSONL files.
- Persist-time pruning is conservative but still replaces saved bytes for selected mechanical cases.
- Prompt-time pruning is non-destructive to stored history but intentionally lossy in the model request.
