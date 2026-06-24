# Changelog

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
