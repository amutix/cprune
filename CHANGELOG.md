# Changelog

## v0.4.3 - 2026-06-30

### Fixed
- Breakdown token buckets now allocate char→token rounding so the displayed per-category tokens sum exactly to the displayed `total` row.
- Added tests asserting the breakdown token allocation reconciles with the total, including a rounding edge case.

## v0.4.2 - 2026-06-30

### Changed
- Added a `total` row to the `/cprune` breakdown so the per-part section reconciles directly with the off/safe/full headline totals.
- The breakdown remains token-only; raw character counts stay internal.

## v0.4.1 - 2026-06-30

### Changed
- `/cprune` breakdown now shows approximate tokens only instead of raw character counts. This keeps the UI focused on the unit users care about and avoids confusion with the header's real request-token usage.

## v0.4.0 - 2026-06-30

### Changed
- New sessions now default to **safe** mode instead of **full**. This makes cprune's stable/default behavior conservative: mechanical duplicate/append/oversize pruning, explicit review exclusions, and low-risk prompt-time cleanup.
- Existing sessions keep their persisted mode. If a session is already in `full`, it stays in `full` until the user runs `/cprune safe` or `/cprune off`.
- README now frames `full` as aggressive opt-in rather than the recommended default. Full remains available for users who want maximum prompt-time savings and accept broader historical-context rewrites.

## v0.3.4 - 2026-06-30

### Fixed
- `/cprune` now explicitly explains the post-reload prefix-freeze state on prefix-cache providers. Because cprune does not persist the full frozen prompt (to avoid session-log bloat), immediately after a new/reloaded process the full row shows fresh next-prompt pruning until one model turn re-establishes the in-memory freeze.
- Clarified the cache model line: prefix-cache full mode freezes the prefix **once established**.

## v0.3.3 - 2026-06-30

### Fixed
- Corrected `/cprune` display semantics on prefix-cache providers: the `full` row now shows the **effective frozen-prefix prompt** that cprune would actually send, not fictional fresh full-pruning potential.
- Kept the real v0.3.2 safe-floor optimization: where full is allowed to prune a message, it still prefers a smaller safe mechanical replacement over a larger full semantic replacement.
- Updated README wording to make the cache-preservation tradeoff explicit: active full can sometimes show less immediate savings than safe because it preserves the already-sent prefix for cache stability.

## v0.3.2 - 2026-06-30

### Fixed
- `/cprune` no longer compares unfrozen `safe` against cache-frozen `full`. The off/safe/full rows now show fresh pruning potential consistently, while `est. saved this turn` remains the actual prompt delta captured before the last model call.
- Full mode now has a safe-floor invariant: when a safe mechanical replacement is smaller than a full semantic replacement for the same message, full uses the smaller safe replacement. This prevents cases where fresh full pruning appears to save less than safe due to rule ordering or longer semantic placeholders.
- Added a short `/cprune` note on prefix-cache providers explaining that active full mode keeps the already-sent prefix frozen for cache stability.

## v0.3.1 - 2026-06-30

### Stabilization / hardening
- Anchored `est. saved this turn` to the exact prompt sent in the `context` hook instead of reconstructing savings after the assistant response. This keeps turn-level savings aligned with the real model request while still pricing with the provider's actual usage/cost data from `agent_end`.
- Added raw-message identity hashes to the prefix-freeze guard. cprune no longer trusts message indexes alone, so branch switches/undo/history rewrites of the same length cannot accidentally reuse frozen pruned forms from a different branch.
- Stopped automatic semantic/entity pruning of user messages in full mode. User messages can still be excluded explicitly via review commands, but full mode no longer rewrites them via latest-entity-wins heuristics.
- Hardened preservation of side-effectful/non-repeatable nested `multi_tool_use.parallel` calls. Wrappers containing edit/write, mutation tools, browser/API-style tools, or side-effectful bash commands now keep their historical arguments/results intact.
- Expanded side-effectful shell detection for `sed/perl -i`, `curl -X POST|PUT|PATCH|DELETE`, `gh release/repo/api/pr/issue` mutations, `git tag`, `dd`, `truncate`, `rsync`, and `install`.
- Removed dead display helpers left behind by the cache-prediction removal.
- Updated README to describe measurement-only cache reporting and the current user-message safety policy.

## v0.3.0 - 2026-06-30

### Changed — prediction removed, measurement only

**cprune no longer predicts cache hit.** Earlier versions built an offline fingerprint model to *predict* per-mode cache hit, but it failed every stress test: it went blank on reload (v0.2.16), showed 98% right after a compaction where the real hit was 2% (v0.2.17), and predicted 0% / fired a scary `consider /cprune safe` warning on gpt-5.5 while the real measured hit was 98.2%. A predictor that's confidently wrong is worse than no predictor, so it's gone.

What `/cprune` shows now:
- **`last turn: X% cache hit · N tok new · $cost`** — the REAL measured hit from the provider's `usage.cacheRead`, nothing predicted.
- **off / safe / full token bars + per-category breakdown** — deterministic char/token math, no prediction.
- **`est. saved this turn` / `session`** — now anchored to the deterministic off-vs-active token delta (same math as the bars), priced at the real input rate.
- **`Cache model: prefix-cache | content-cache`** — just the detected model (explains why full mode freezes its prefix on prefix-sensitive providers). No hit %, no warnings.

Removed: `fingerprintsFor`, `cacheModel`, the per-mode prediction state, the compaction-rebuild flag, the reload-baseline persistence, the `relativeCacheCost` model, and the `⚠ consider safe` warning. ~170 lines deleted.

Kept (and unchanged): the cache-aware **prefix freeze** on prefix-sensitive providers — that's a *protective action*, not a prediction, and it still does its job.

## v0.2.17 - 2026-06-30

### Fixed
- **Cache prediction no longer lies after compaction.** Right after a compaction, `/cprune` showed a confidently-high predicted cache hit (e.g. `98%`) next to a real `last turn: 2%`. Both were individually "correct" but measured different reference frames: the real 2% reflected the compaction turn (where the provider's cache was invalidated), while the 98% was a trivial post-compaction-vs-post-compaction self-comparison. cprune now detects the history shrink, drops the stale baseline, and shows an honest `context was just compacted — cache is rebuilding` note for one turn, then resumes valid predictions.

## v0.2.16 - 2026-06-30

### Fixed
- **Stats no longer blank after a bare reload.** Three reload gaps closed:
  - The cache-prediction section (off/safe/full hit %, change@N) is now recomputed from the current context against the restored baseline whenever `/cprune` runs — previously it went blank ("run one more turn") until a new turn fired.
  - The provider cache model is recomputed from the restored last usage, so it shows the correct `prefix-cache` / `content-cache` instead of `unknown` after reload.
  - `est. saved this turn` now persists across reload (it reset to `$0.00`).

## v0.2.15 - 2026-06-30

### Fixed
- **Stats now survive reloads.** The cache-prediction baseline and cumulative session cost savings are persisted in cprune state, so the off/safe/full cache-hit estimates and the cumulative `est. saved session` no longer reset to blank/zero when you reload a session. (The committed-prefix freeze is still in-memory and re-establishes after one turn on reload, since persisting full message forms would bloat the session log.)

## v0.2.14 - 2026-06-30

### Changed
- Cache hit is now shown with one decimal place (predicted and actual) so a near-perfect cache reads as e.g. `99.7%` rather than a misleading `100%`. The actual last-turn line also surfaces the uncached `new` token count, making it clear there is always a small new tail that misses.

## v0.2.13 - 2026-06-30

### Changed
- Reframed the cache section in the README as **cache preservation** (a known risk that cprune is designed to avoid) instead of a before/after remediation table.

## v0.2.12 - 2026-06-30

### Added
- **"Measured cache impact" section** in the README documenting the real before/after result: on gpt-5.5 (prefix-cache), cache hit went from 7–8% → 100% and per-turn cost from ~$0.50 → ~$0.09 once the cache-aware prefix-freeze is active; on glm/zai (content-cache) it stays ~99% with full aggression.

### Fixed
- Marked v0.2.4–v0.2.6 as pre-release. Those versions ship the older cache-breaking full-mode behavior (retrospective supersession that invalidated the prefix cache on OpenAI/gpt and Anthropic). Use v0.2.12 (cache-aware freeze) or later.

## v0.2.11 - 2026-06-30

### Fixed
- **Cost estimates now always show.** Previously, when a provider reported no billing (e.g. zai/glm gateways reporting `$0` cost), all cost/savings numbers were suppressed. Cost now falls back to **assumed model pricing** (configurable per model prefix, default $0.50/M tokens) and is labeled `(assumed pricing)` so it's honest about the source. Providers that report real billing (gpt, claude, etc.) continue to use the actual per-token rate with no label.
- Added a `modelInputPricePerMTok` config table for common models (gpt, o1/o3, claude variants, glm, gemini, deepseek, llama) plus a `fallbackInputPricePerMTok` default.

## v0.2.10 - 2026-06-30

### Fixed
- Restored the **per-category breakdown** (off/safe/full bars split by context part) in `/cprune`. It was unintentionally removed in v0.2.9 alongside the verbosity cleanup.

## v0.2.9 - 2026-06-30

### Changed
- **Redesigned `/cprune` output** to be concise and cost-aware. The verbose summary, per-category breakdown, and dense cache rows were replaced with a compact layout: a one-line header (mode · model · context usage), last-turn cache hit + cost, a clean off/safe/full token bar with per-mode savings, and estimated **cost savings** (this turn + cumulative session).

### Added
- **Estimated cost savings** derived from real per-token billing (`usage.cost.input / input`, with a blended fallback). Under the cache-aware prefix-freeze, pruned tokens are uncached new-tail tokens, so pricing them at the real input rate is a fair estimate of money saved.
- Cumulative session cost savings persisted across turns.

## v0.2.8 - 2026-06-30

### Fixed
- Provider cache-model detection now normalizes the provider slug before matching, so hyphenated/underscored names classify correctly (e.g. `z-ai` → content-cache; previously mis-detected as strict-prefix). This ensures the cache predictor and the prefix-freeze use the right model per provider.

## v0.2.7 - 2026-06-30

### Added
- **Cache-aware full mode.** full mode now **freezes the committed prefix**: once a message's pruned form is sent to the model, that form is locked, so the prompt prefix stays byte-identical across turns and prompt caching is preserved on prefix-sensitive providers (OpenAI/gpt, Anthropic). Only the new (uncommitted) tail is pruned each turn.
  - Measured motivation: on gpt-5.5, aggressive full mode broke the cache every turn (7–8% cache hit, ~$0.48–0.63/turn for ~120k re-billed input tokens). With prefix freezing, the prefix never retroactively changes, so the cache reads the whole stable prefix and only the genuinely new tail misses.
  - Within-turn savings are preserved (dedup/truncation of tool results that arrive in the same turn, before first send); cross-turn retrospective supersession is disabled for already-sent messages because that was the source of the cache breaks.
  - Content-cache providers (zai/glm gateways) are unaffected and keep aggressive full mode (no cache penalty there).
  - Resets the frozen prefix after compaction (history shrink) and on session start.

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
