import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type AnyMessage = any;
type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; [key: string]: unknown };
type Content = TextContent | ImageContent | Record<string, unknown>;

type SeenOutput = {
  hash: string;
  toolName: string;
  input: string;
  firstSeenAt: number;
  count: number;
  chars: number;
  normalizedHash?: string;
  normalizedChars?: number;
  normalizedLineCount?: number;
};

type OutputFingerprint = SeenOutput & { index?: number };

type AppendMatch = {
  prior: OutputFingerprint;
  startBoundary: number;
  endBoundary: number;
  kind: "exact-prefix" | "normalized-prefix" | "normalized-contained";
};

type CpruneStats = {
  toolResultsSeen: number;
  toolResultsDeduped: number;
  toolResultsNormalizedDeduped: number;
  toolResultsAppendPruned: number;
  toolResultsTruncated: number;
  contextPasses: number;
  contextMessagesTouched: number;
  contextStaleReads: number;
  contextDuplicates: number;
  contextAppendPruned: number;
  contextSupersededCommands: number;
  contextSupersededToolResults: number;
  contextChunkPruned: number;
  contextCustomMessagesPruned: number;
  contextEntityPruned: number;
  contextToolCallArgsPruned: number;
  contextToolCallsCompacted: number;
  contextTruncations: number;
  manualContextOmissions: number;
  thinkingBlocksDropped: number;
  approxCharsSaved: number;
  savedThinkingChars: number;
  savedStaleReadChars: number;
  savedDuplicateChars: number;
  savedAppendChars: number;
  savedSupersededCommandChars: number;
  savedSupersededToolResultChars: number;
  savedChunkChars: number;
  savedCustomChars: number;
  savedEntityChars: number;
  savedToolCallArgChars: number;
  savedTruncationChars: number;
  savedManualOmissionChars: number;
  entityFamilyPruned: Record<string, number>;
  entityFamilySavedChars: Record<string, number>;
  compactionsTriggered: number;
};

const CUSTOM_TYPE = "cprune:state";

type CpruneMode = "off" | "safe" | "full";

const config = {
  // Persist-time pruning: affects what gets stored in the session from now on.
  minDuplicateChars: 1_000,
  minAppendPrefixChars: 1_000,
  maxAppendedSuffixChars: 8_000,
  maxPersistedToolResultChars: 12_000,

  // Send-time pruning: non-destructive; only affects the LLM request context.
  keepRecentMessagesUntouched: 24,
  maxContextToolResultChars: 6_000,
  maxContextCustomMessageChars: 4_000,
  maxEntityPreviewChars: 900,
  minEntityPruneChars: 700,
  maxToolCallArgStringChars: 800,
  maxPriorityToolCallArgStringChars: 300,
  minHistoricalToolCallArgChars: 500,
  minStructuredNoticeChars: 160,
  minSupersededToolResultChars: 500,
  minRepeatedChunkLines: 24,
  minRepeatedChunkChars: 1_200,
  maxSeenHashes: 300,
  maxReviewCandidates: 20,
  reviewCommandPageSize: 10,

  // Background compaction trigger. Set to 0 to disable.
  autoCompactAtPercent: 82,
  compactCooldownMs: 10 * 60 * 1_000,
};

const stats: CpruneStats = {
  toolResultsSeen: 0,
  toolResultsDeduped: 0,
  toolResultsNormalizedDeduped: 0,
  toolResultsAppendPruned: 0,
  toolResultsTruncated: 0,
  contextPasses: 0,
  contextMessagesTouched: 0,
  contextStaleReads: 0,
  contextDuplicates: 0,
  contextAppendPruned: 0,
  contextSupersededCommands: 0,
  contextSupersededToolResults: 0,
  contextChunkPruned: 0,
  contextCustomMessagesPruned: 0,
  contextEntityPruned: 0,
  contextToolCallArgsPruned: 0,
  contextToolCallsCompacted: 0,
  contextTruncations: 0,
  manualContextOmissions: 0,
  thinkingBlocksDropped: 0,
  approxCharsSaved: 0,
  savedThinkingChars: 0,
  savedStaleReadChars: 0,
  savedDuplicateChars: 0,
  savedAppendChars: 0,
  savedSupersededCommandChars: 0,
  savedSupersededToolResultChars: 0,
  savedChunkChars: 0,
  savedCustomChars: 0,
  savedEntityChars: 0,
  savedToolCallArgChars: 0,
  savedTruncationChars: 0,
  savedManualOmissionChars: 0,
  entityFamilyPruned: {},
  entityFamilySavedChars: {},
  compactionsTriggered: 0,
};

type ManualOmission = {
  hash: string;
  label: string;
  role: string;
  chars: number;
  preview: string;
  createdAt: number;
};

type ManualTurnOmission = {
  hash: string;
  label: string;
  chars: number;
  messageCount: number;
  preview: string;
  createdAt: number;
};

const seenOutputs = new Map<string, SeenOutput>();
const manualOmissions = new Map<string, ManualOmission>();
const manualTurnOmissions = new Map<string, ManualTurnOmission>();
let lastCompactAt = 0;
let compactInFlight = false;
let mode: CpruneMode = "full";

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function shortHash(hash: string): string {
  return hash.slice(0, 16);
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function normalizedLinesForAppend(text: string): string[] {
  const lines = stripAnsi(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());

  // Treat a final newline as a line terminator, not as meaningful empty content.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function appendFingerprint(text: string) {
  const lines = normalizedLinesForAppend(text);
  const normalizedText = lines.join("\n");
  return {
    normalizedText,
    normalizedHash: hashText(normalizedText),
    normalizedChars: normalizedText.length,
    normalizedLineCount: lines.length,
  };
}

function rawBoundaryAfterNormalizedLines(text: string, lineCount: number): number {
  if (lineCount <= 0) return 0;
  let seenNewlines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      seenNewlines++;
      if (seenNewlines === lineCount) return i + 1;
    }
  }
  return text.length;
}

function rawLineStart(text: string, lineIndex: number): number {
  if (lineIndex <= 0) return 0;
  let seenNewlines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      seenNewlines++;
      if (seenNewlines === lineIndex) return i + 1;
    }
  }
  return text.length;
}

function isSnapshotCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const normalized = command.trim().replace(/\s+/g, " ");
  return /^(ls|find|rg|grep|wc|git status|git diff(?!\s+apply\b)|git ls-files|git grep)\b/.test(normalized);
}

function safeJson(value: unknown, max = 220): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (!text) return "{}";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is TextContent => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function textContent(text: string): TextContent[] {
  return [{ type: "text", text }];
}

function truncateMiddle(text: string, maxChars: number, label: string): { text: string; saved: number } {
  if (text.length <= maxChars) return { text, saved: 0 };

  const marker = `\n\n[cprune: omitted ${text.length - maxChars} chars from ${label}]\n\n`;
  const room = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(room * 0.65);
  const tail = Math.max(0, room - head);
  return {
    text: `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`,
    saved: text.length - maxChars,
  };
}

const ENTITY_ID_RE = /\b(?:TASK|SPEC|DISC|ISSUE|BUG|PR|MR|EPIC|INIT|MILESTONE|REQ|DOC)-\d+\b/gi;

type EntitySeen = { index: number; hash: string; ids: string[]; chars: number };

function extractEntityIds(text: string): string[] {
  return [...new Set([...text.matchAll(ENTITY_ID_RE)].map((match) => match[0].toUpperCase()))];
}

function entityFamily(id: string): string {
  const prefix = id.split("-")[0]?.toUpperCase() || "ENTITY";
  return `${prefix}-*`;
}

function recordEntityFamilySavings(ids: string[], saved: number) {
  if (saved <= 0 || ids.length === 0) return;
  const families = [...new Set(ids.map(entityFamily))];
  for (const family of families) {
    stats.entityFamilyPruned[family] = (stats.entityFamilyPruned[family] ?? 0) + 1;
    stats.entityFamilySavedChars[family] = (stats.entityFamilySavedChars[family] ?? 0) + saved;
  }
}

function normalizeEntityText(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n?/g, "\n")
    .replace(/^\s*\[[^\]]{0,160}\]\s*/gm, "")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][0-9:.+-Z]*\b/g, "<time>")
    .replace(/\b[0-9a-f]{7,40}\b/gi, "<hash>")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .toLowerCase();
}

function previewEntityText(text: string, maxChars = config.maxEntityPreviewChars): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line, index) => index < 2 || /\b(?:TASK|SPEC|DISC|ISSUE|BUG|PR|MR|EPIC|INIT|MILESTONE|REQ|DOC)-\d+\b/i.test(line));
  const preview = lines.slice(0, 8).join("\n").trim() || text.slice(0, maxChars);
  return truncateMiddle(preview, maxChars, "entity preview").text;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function extractPaths(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === "string") {
    const normalized = normalizePath(value);
    if (!normalized) return [];
    if (/[/\\]/.test(value) || /\.[a-z0-9]{1,8}$/i.test(value)) return [normalized];
    return [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => extractPaths(item, depth + 1));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      if (/path|file|dir|cwd/i.test(key) && typeof item === "string") return extractPaths(item, depth + 1);
      return extractPaths(item, depth + 1);
    });
  }
  return [];
}

function isCoreToolName(toolName: string): boolean {
  return ["read", "bash", "edit", "write", "multi_tool_use.parallel"].includes(toolName);
}

function stripBoilerplateNoticeTails(text: string): { text: string; saved: number; stripped: boolean } {
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((line) => {
    const normalized = line.trim();
    return !/^Run\s+\w+(?:_\w+)?\s+show\b.*(?:full|context|details|latest|current)/i.test(normalized)
      && !/^Use\s+\w+(?:_\w+)?\s+show\b.*(?:full|context|details|latest|current)/i.test(normalized)
      && !/^For\s+full\s+context,?\s+run\b/i.test(normalized);
  });
  const next = kept.join("\n");
  return { text: next, saved: Math.max(0, text.length - next.length), stripped: next !== text };
}

function structuredNoticeEvent(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "notice";
  const bracket = firstLine.match(/^\[([^:\]]+)(?::|\])/);
  const event = text.match(/\b(assigned|unassigned|picked|started|blocked|unblocked|review|reviewed|done|completed|closed|created|updated|commented|mentioned|notified|notification)\b/i)?.[1];
  return [bracket?.[1], event?.toLowerCase()].filter(Boolean).join("/") || "structured notice";
}

function pruneStructuredEntityNotice(
  text: string,
  label: string,
  index: number,
  latestEntityIndex: Map<string, number>,
): { text: string; saved: number; pruned: boolean; strippedBoilerplate: boolean } {
  const boilerplate = stripBoilerplateNoticeTails(text);
  const working = boilerplate.text;
  const ids = extractEntityIds(working);
  const latest = ids.length ? Math.max(...ids.map((id) => latestEntityIndex.get(id) ?? index)) : index;
  const looksStructured = /^\s*\[[a-z][^\]]{0,120}\]/i.test(working) || /\b(?:Run|Use)\s+\w+(?:_\w+)?\s+show\b/i.test(text);

  if (ids.length > 0 && looksStructured && working.length >= config.minStructuredNoticeChars && latest > index) {
    const hash = hashText(normalizeEntityText(working) || working);
    const preview = previewEntityText(working, 260);
    const replacement = `[cprune: older structured ${label} notice compacted; event=${structuredNoticeEvent(working)}; entities=${ids.join(",")}; newer mention appears at message index ${latest}; hash=${shortHash(hash)}; original=${text.length} chars.]\n${preview}`;
    return {
      text: replacement,
      saved: Math.max(0, text.length - replacement.length),
      pruned: true,
      strippedBoilerplate: boilerplate.stripped,
    };
  }

  if (boilerplate.stripped && boilerplate.saved > 0) {
    return { text: working, saved: boilerplate.saved, pruned: true, strippedBoilerplate: true };
  }

  return { text, saved: 0, pruned: false, strippedBoilerplate: false };
}

function toolEntityIds(toolName: string, text: string, args: unknown): string[] {
  if (isCoreToolName(toolName)) return [];
  return uniqueSorted([...extractEntityIds(text), ...extractEntityIds(safeJson(args, 20_000))]);
}

function compactHistoricalToolCall(block: any): { block: any; saved: number; pruned: boolean } {
  const args = block?.arguments ?? {};
  const original = safeJson(args, 40_000);
  if (original.length < config.minHistoricalToolCallArgChars) return { block, saved: 0, pruned: false };

  const ids = extractEntityIds(original);
  const paths = uniqueSorted(extractPaths(args)).slice(0, 8);
  const replacementArgs: Record<string, unknown> = {
    _cprune: "successful historical tool call arguments compacted",
    hash: shortHash(hashText(original)),
    originalChars: original.length,
  };
  if (ids.length > 0) replacementArgs.entities = ids;
  if (paths.length > 0) replacementArgs.paths = paths;
  replacementArgs.preview = truncateMiddle(original, 220, "tool call arg preview").text;

  const replacementChars = safeJson(replacementArgs, 40_000).length;
  const saved = original.length - replacementChars;
  if (saved <= 0) return { block, saved: 0, pruned: false };
  return { block: { ...block, arguments: replacementArgs }, saved, pruned: true };
}

function messageTextForEntities(message: AnyMessage): string {
  if (!message) return "";
  if (message.role === "assistant" && Array.isArray(message.content)) {
    return message.content
      .map((block: any) => {
        if (block?.type === "text") return block.text ?? "";
        if (block?.type === "toolCall") return safeJson(block.arguments ?? {}, 20_000);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (message.role === "user" || message.role === "toolResult" || message.role === "custom") {
    return textFromContent(message.content);
  }
  if (message.role === "compactionSummary" || message.role === "branchSummary") return String(message.summary ?? "");
  return "";
}

function pruneEntityText(
  text: string,
  label: string,
  index: number,
  latestEntityIndex: Map<string, number>,
  seenEntities: Map<string, EntitySeen>,
): { text: string; saved: number; pruned: boolean; kind?: "duplicate" | "superseded" } {
  if (text.length < config.minEntityPruneChars) return { text, saved: 0, pruned: false };
  const ids = extractEntityIds(text);
  if (ids.length === 0) return { text, saved: 0, pruned: false };

  const normalized = normalizeEntityText(text);
  if (!normalized) return { text, saved: 0, pruned: false };
  const hash = hashText(normalized);
  const duplicate = ids
    .map((id) => seenEntities.get(`${id}:${hash}`))
    .find((seen): seen is EntitySeen => seen !== undefined);

  for (const id of ids) {
    seenEntities.set(`${id}:${hash}`, { index, hash, ids, chars: text.length });
  }

  if (duplicate) {
    const replacement = `[cprune: duplicate entity content omitted from ${label}; entities=${ids.join(",")}; same normalized content appeared at message index ${duplicate.index}; hash=${shortHash(hash)}.]`;
    return { text: replacement, saved: Math.max(0, text.length - replacement.length), pruned: true, kind: "duplicate" };
  }

  const latest = Math.max(...ids.map((id) => latestEntityIndex.get(id) ?? index));
  if (latest > index) {
    const preview = previewEntityText(text);
    const replacement = `[cprune: older entity snapshot compacted from ${label}; entities=${ids.join(",")}; newer mention appears at message index ${latest}; hash=${shortHash(hash)}; original=${text.length} chars.]\n${preview}`;
    return { text: replacement, saved: Math.max(0, text.length - replacement.length), pruned: true, kind: "superseded" };
  }

  return { text, saved: 0, pruned: false };
}

function recordSavings(saved: number, field?: keyof CpruneStats) {
  if (saved <= 0) return;
  stats.approxCharsSaved += saved;
  if (field) {
    const current = stats[field];
    if (typeof current === "number") {
      (stats as any)[field] = current + saved;
    }
  }
}

function mergeStats(saved: number) {
  recordSavings(saved);
}

function rememberOutput(hash: string, toolName: string, input: unknown, chars: number, text?: string): SeenOutput | undefined {
  const existing = seenOutputs.get(hash);
  if (existing) {
    existing.count++;
    return existing;
  }

  const fp = text ? appendFingerprint(text) : undefined;
  seenOutputs.set(hash, {
    hash,
    toolName,
    input: safeJson(input),
    firstSeenAt: Date.now(),
    count: 1,
    chars,
    normalizedHash: fp?.normalizedHash,
    normalizedChars: fp?.normalizedChars,
    normalizedLineCount: fp?.normalizedLineCount,
  });

  while (seenOutputs.size > config.maxSeenHashes) {
    const oldest = seenOutputs.keys().next().value;
    if (!oldest) break;
    seenOutputs.delete(oldest);
  }

  return undefined;
}

function findAppendedOutput(text: string, toolName: string, candidates: OutputFingerprint[]): AppendMatch | undefined {
  // First pass: exact byte prefix. This is the safest and catches pure append-only growth.
  const exactCandidates = candidates
    .filter(
      (seen) =>
        seen.toolName === toolName &&
        seen.chars >= config.minAppendPrefixChars &&
        seen.chars < text.length,
    )
    .sort((a, b) => b.chars - a.chars);

  for (const seen of exactCandidates) {
    if (hashText(text.slice(0, seen.chars)) === seen.hash) {
      return { prior: seen, startBoundary: 0, endBoundary: seen.chars, kind: "exact-prefix" };
    }
  }

  // Second pass: normalized line-prefix. This catches append-only output where ANSI escapes,
  // CRLF/LF, or trailing whitespace differ, while still requiring the old content to be a prefix.
  const currentFp = appendFingerprint(text);
  const normalizedCandidates = candidates
    .filter(
      (seen) =>
        seen.toolName === toolName &&
        (seen.normalizedChars ?? 0) >= config.minAppendPrefixChars &&
        (seen.normalizedChars ?? 0) < currentFp.normalizedChars &&
        (seen.normalizedLineCount ?? 0) > 0 &&
        (seen.normalizedLineCount ?? 0) < currentFp.normalizedLineCount,
    )
    .sort((a, b) => (b.normalizedChars ?? 0) - (a.normalizedChars ?? 0));

  for (const seen of normalizedCandidates) {
    const normalizedChars = seen.normalizedChars ?? 0;
    if (hashText(currentFp.normalizedText.slice(0, normalizedChars)) === seen.normalizedHash) {
      return {
        prior: seen,
        startBoundary: 0,
        endBoundary: rawBoundaryAfterNormalizedLines(text, seen.normalizedLineCount ?? 0),
        kind: "normalized-prefix",
      };
    }
  }

  // Third pass: contained normalized block. This catches wrappers like
  // "command header + previous output + appended tail". It is deliberately
  // limited to substantial multi-line outputs to avoid over-pruning short snippets.
  const currentLines = normalizedLinesForAppend(text);
  const containedCandidates = normalizedCandidates.filter((seen) => (seen.normalizedLineCount ?? 0) >= 20);
  for (const seen of containedCandidates) {
    const lineCount = seen.normalizedLineCount ?? 0;
    const maxStart = currentLines.length - lineCount;
    if (maxStart <= 0) continue;

    for (let startLine = 1; startLine <= maxStart; startLine++) {
      const windowHash = hashText(currentLines.slice(startLine, startLine + lineCount).join("\n"));
      if (windowHash === seen.normalizedHash) {
        return {
          prior: seen,
          startBoundary: rawLineStart(text, startLine),
          endBoundary: rawBoundaryAfterNormalizedLines(text, startLine + lineCount),
          kind: "normalized-contained",
        };
      }
    }
  }

  return undefined;
}

function findAppendedSeenOutput(text: string, toolName: string): AppendMatch | undefined {
  return findAppendedOutput(text, toolName, [...seenOutputs.values()]);
}

function findNormalizedDuplicateSeenOutput(text: string, toolName: string): { prior: SeenOutput; fingerprint: ReturnType<typeof appendFingerprint> } | undefined {
  const fingerprint = appendFingerprint(text);
  if (fingerprint.normalizedChars < config.minDuplicateChars) return undefined;

  for (const prior of seenOutputs.values()) {
    if (prior.toolName !== toolName) continue;
    if (prior.normalizedHash !== fingerprint.normalizedHash) continue;
    if (prior.normalizedChars !== fingerprint.normalizedChars) continue;
    if (prior.normalizedLineCount !== fingerprint.normalizedLineCount) continue;
    return { prior, fingerprint };
  }

  return undefined;
}

function appendedReplacement(text: string, toolName: string, match: AppendMatch): { text: string; saved: number } {
  const start = Math.max(0, Math.min(match.startBoundary, text.length));
  const end = Math.max(start, Math.min(match.endBoundary, text.length));
  const omittedChars = end - start;
  const prefix = text.slice(0, start);
  const suffix = text.slice(end);
  const suffixTrimmed = truncateMiddle(suffix, config.maxAppendedSuffixChars, `newly appended ${toolName} output`);
  const location = start === 0 ? "prefix" : "contained block";
  const header =
    match.prior.index === undefined
      ? `[cprune: omitted ${omittedChars} repeated ${location} chars from ${toolName} result; match=${match.kind}; hash=${shortHash(match.prior.hash)}; first input=${match.prior.input}. New/non-repeated output follows.]\n`
      : `[cprune: omitted ${omittedChars} repeated ${location} chars from ${toolName} result; match=${match.kind}; same block appeared at message index ${match.prior.index}; hash=${shortHash(match.prior.hash)}. New/non-repeated output follows.]\n`;

  return {
    text: `${prefix}${header}${suffixTrimmed.text}`,
    saved: Math.max(0, omittedChars - header.length) + suffixTrimmed.saved,
  };
}

function persistedTruncation(text: string, maxChars: number, toolName: string): { text: string; saved: number; hash: string } {
  const hash = hashText(text);
  if (text.length <= maxChars) return { text, saved: 0, hash };

  const marker = `\n\n[cprune: omitted ${text.length - maxChars} chars from ${toolName} result before persistence; hash=${shortHash(hash)}; original=${text.length} chars.]\n\n`;
  const room = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(room * 0.65);
  const tail = Math.max(0, room - head);
  return {
    text: `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`,
    saved: text.length - maxChars,
    hash,
  };
}

function loadStateFromSession(ctx: any) {
  const entries = ctx.sessionManager.getEntries?.() ?? [];
  const stateEntry = [...entries]
    .reverse()
    .find((entry: any) => entry.type === "custom" && entry.customType === CUSTOM_TYPE && entry.data);

  if (!stateEntry?.data) return;

  Object.assign(stats, stateEntry.data.stats ?? {});
  stats.entityFamilyPruned = { ...(stateEntry.data.stats?.entityFamilyPruned ?? {}) };
  stats.entityFamilySavedChars = { ...(stateEntry.data.stats?.entityFamilySavedChars ?? {}) };
  lastCompactAt = stateEntry.data.lastCompactAt ?? 0;
  mode = stateEntry.data.mode ?? (stateEntry.data.enabled === false ? "off" : "full");

  if (Array.isArray(stateEntry.data.seenOutputs)) {
    seenOutputs.clear();
    for (const item of stateEntry.data.seenOutputs.slice(-config.maxSeenHashes)) {
      if (item?.hash) seenOutputs.set(item.hash, item);
    }
  }

  if (Array.isArray(stateEntry.data.manualOmissions)) {
    manualOmissions.clear();
    for (const item of stateEntry.data.manualOmissions) {
      if (item?.hash) manualOmissions.set(item.hash, item);
    }
  }

  if (Array.isArray(stateEntry.data.manualTurnOmissions)) {
    manualTurnOmissions.clear();
    for (const item of stateEntry.data.manualTurnOmissions) {
      if (item?.hash) manualTurnOmissions.set(item.hash, item);
    }
  }
}

function saveState(pi: ExtensionAPI) {
  pi.appendEntry(CUSTOM_TYPE, {
    stats,
    enabled: mode !== "off",
    mode,
    lastCompactAt,
    seenOutputs: [...seenOutputs.values()].slice(-config.maxSeenHashes),
    manualOmissions: [...manualOmissions.values()],
    manualTurnOmissions: [...manualTurnOmissions.values()],
    savedAt: Date.now(),
  });
}

function getAssistantToolCalls(messages: AnyMessage[]) {
  const calls = new Map<string, { name: string; args: Record<string, unknown>; messageIndex: number }>();

  messages.forEach((message, messageIndex) => {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (block?.type === "toolCall" && typeof block.id === "string") {
        calls.set(block.id, {
          name: String(block.name ?? ""),
          args: (block.arguments ?? {}) as Record<string, unknown>,
          messageIndex,
        });
      }
    }
  });

  return calls;
}

function normalizePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.replace(/\\/g, "/");
}

function cloneWithText(message: AnyMessage, text: string): AnyMessage {
  if (message?.role === "compactionSummary" || message?.role === "branchSummary") {
    return { ...message, summary: text };
  }
  if (message?.role === "bashExecution") {
    return { ...message, output: text };
  }
  return {
    ...message,
    content: textContent(text),
  };
}

function pruneAssistantThinking(message: AnyMessage): { message: AnyMessage; saved: number; dropped: number } {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) {
    return { message, saved: 0, dropped: 0 };
  }

  let saved = 0;
  let dropped = 0;
  const kept: Content[] = [];

  for (const block of message.content) {
    if (block?.type === "thinking" && typeof block.thinking === "string") {
      saved += block.thinking.length;
      dropped++;
      continue;
    }
    kept.push(block);
  }

  if (dropped === 0) return { message, saved: 0, dropped: 0 };

  return {
    message: {
      ...message,
      content: kept.length > 0 ? kept : textContent("[cprune: old assistant reasoning omitted]"),
    },
    saved,
    dropped,
  };
}

function pruneArgValue(value: unknown, path: string): { value: unknown; saved: number; pruned: number } {
  if (typeof value === "string") {
    const key = path.split(/[.[\]]/).filter(Boolean).at(-1)?.toLowerCase() ?? path.toLowerCase();
    const priority = /^(content|summary|description|message|body|text|oldtext|newtext|spec|plan|comment|details|instructions)$/i.test(key);
    const limit = priority ? config.maxPriorityToolCallArgStringChars : config.maxToolCallArgStringChars;
    if (value.length <= limit) return { value, saved: 0, pruned: 0 };
    const ids = extractEntityIds(value);
    const preview = value.slice(0, Math.min(260, limit)).replace(/\s+/g, " ").trim();
    const replacement = `[cprune: omitted prior tool-call argument ${path}; ${value.length} chars; hash=${shortHash(hashText(value))}${ids.length ? `; entities=${ids.join(",")}` : ""}; preview=${JSON.stringify(preview)}]`;
    return { value: replacement, saved: Math.max(0, value.length - replacement.length), pruned: 1 };
  }

  if (Array.isArray(value)) {
    let saved = 0;
    let pruned = 0;
    const next = value.map((item, index) => {
      const result = pruneArgValue(item, `${path}[${index}]`);
      saved += result.saved;
      pruned += result.pruned;
      return result.value;
    });
    return { value: next, saved, pruned };
  }

  if (value && typeof value === "object") {
    let saved = 0;
    let pruned = 0;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const result = pruneArgValue(child, path ? `${path}.${key}` : key);
      saved += result.saved;
      pruned += result.pruned;
      next[key] = result.value;
    }
    return { value: next, saved, pruned };
  }

  return { value, saved: 0, pruned: 0 };
}

function pruneAssistantContext(
  message: AnyMessage,
  index: number,
  latestEntityIndex: Map<string, number>,
  seenEntities: Map<string, EntitySeen>,
  successfulToolCallIds: Set<string>,
): {
  message: AnyMessage;
  saved: number;
  savedEntity: number;
  savedToolArgs: number;
  touched: boolean;
  entityPruned: number;
  toolArgsPruned: number;
  toolCallsCompacted: number;
} {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) {
    return { message, saved: 0, savedEntity: 0, savedToolArgs: 0, touched: false, entityPruned: 0, toolArgsPruned: 0, toolCallsCompacted: 0 };
  }

  let saved = 0;
  let savedEntity = 0;
  let savedToolArgs = 0;
  let touched = false;
  let entityPruned = 0;
  let toolArgsPruned = 0;
  let toolCallsCompacted = 0;

  const content = message.content.map((block: any) => {
    if (block?.type === "text" && typeof block.text === "string") {
      const pruned = pruneEntityText(block.text, "assistant text", index, latestEntityIndex, seenEntities);
      if (pruned.pruned) {
        saved += pruned.saved;
        savedEntity += pruned.saved;
        recordEntityFamilySavings(extractEntityIds(block.text), pruned.saved);
        touched = true;
        entityPruned++;
        return { ...block, text: pruned.text };
      }
      return block;
    }

    if (block?.type === "toolCall" && successfulToolCallIds.has(block.id)) {
      const compacted = compactHistoricalToolCall(block);
      if (compacted.pruned) {
        saved += compacted.saved;
        savedToolArgs += compacted.saved;
        touched = true;
        toolArgsPruned++;
        toolCallsCompacted++;
        return compacted.block;
      }

      const result = pruneArgValue(block.arguments ?? {}, `${block.name ?? "tool"}.arguments`);
      if (result.pruned > 0) {
        saved += result.saved;
        savedToolArgs += result.saved;
        touched = true;
        toolArgsPruned += result.pruned;
        return { ...block, arguments: result.value };
      }
    }

    return block;
  });

  if (!touched) {
    return { message, saved: 0, savedEntity: 0, savedToolArgs: 0, touched: false, entityPruned: 0, toolArgsPruned: 0, toolCallsCompacted: 0 };
  }
  return { message: { ...message, content }, saved, savedEntity, savedToolArgs, touched, entityPruned, toolArgsPruned, toolCallsCompacted };
}

function rememberContextFingerprint(
  fingerprints: OutputFingerprint[],
  hash: string,
  index: number,
  label: string,
  text: string,
) {
  const fp = appendFingerprint(text);
  fingerprints.push({
    hash,
    index,
    toolName: label,
    input: "context",
    firstSeenAt: Date.now(),
    count: 1,
    chars: text.length,
    normalizedHash: fp.normalizedHash,
    normalizedChars: fp.normalizedChars,
    normalizedLineCount: fp.normalizedLineCount,
  });
}

type ChunkSeen = { index: number; label: string; chars: number };

function pruneRepeatedLineChunks(
  text: string,
  label: string,
  index: number,
  seenChunks: Map<string, ChunkSeen>,
): { text: string; saved: number; pruned: number } {
  const lines = normalizedLinesForAppend(text);
  if (lines.length < config.minRepeatedChunkLines * 2) return { text, saved: 0, pruned: 0 };

  const rawLines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let saved = 0;
  let pruned = 0;

  for (let i = 0; i < lines.length; i += config.minRepeatedChunkLines) {
    const chunkLines = lines.slice(i, i + config.minRepeatedChunkLines);
    const chunkText = chunkLines.join("\n");
    const rawChunk = rawLines.slice(i, i + config.minRepeatedChunkLines).join("\n");

    if (chunkLines.length === config.minRepeatedChunkLines && chunkText.length >= config.minRepeatedChunkChars) {
      const hash = hashText(`${label}\n${chunkText}`);
      const seen = seenChunks.get(hash);
      if (seen) {
        const marker = `[cprune: omitted repeated ${label} chunk (${chunkLines.length} lines, ${rawChunk.length} chars); same chunk appeared at message index ${seen.index}.]`;
        out.push(marker);
        saved += Math.max(0, rawChunk.length - marker.length);
        pruned++;
        continue;
      }
      seenChunks.set(hash, { index, label, chars: rawChunk.length });
    }

    out.push(rawChunk);
  }

  if (pruned === 0) return { text, saved: 0, pruned: 0 };
  return { text: out.join("\n"), saved, pruned };
}

function pruneContextMessages(messages: AnyMessage[], pruneMode: CpruneMode = mode): AnyMessage[] {
  if (pruneMode === "off") return messages;
  stats.contextPasses++;
  const fullMode = pruneMode === "full";

  const turnOmitted = applyManualTurnOmissions(messages);
  messages = turnOmitted.messages;

  const calls = getAssistantToolCalls(messages);
  const recentStart = Math.max(0, messages.length - config.keepRecentMessagesUntouched);
  const latestReadByPath = new Map<string, number>();
  const latestMutationByPath = new Map<string, number>();
  const latestSnapshotCommand = new Map<string, number>();
  const latestToolEntityResult = new Map<string, number>();
  const latestEntityIndex = new Map<string, number>();
  const successfulToolCallIds = new Set<string>();

  messages.forEach((message, index) => {
    for (const id of extractEntityIds(messageTextForEntities(message))) {
      latestEntityIndex.set(id, index);
    }

    if (message?.role === "toolResult" && !message.isError && typeof message.toolCallId === "string") {
      successfulToolCallIds.add(message.toolCallId);
    }

    if (message?.role === "toolResult") {
      const call = calls.get(message.toolCallId);
      const toolName = call?.name ?? message.toolName ?? "tool";
      if (fullMode && call?.name === "read") {
        const path = normalizePath(call.args.path);
        if (path && !message.isError) latestReadByPath.set(path, index);
      }
      if (call?.name === "bash" && !message.isError && isSnapshotCommand(call.args.command)) {
        latestSnapshotCommand.set(String(call.args.command).trim(), index);
      }
      if (!message.isError) {
        const ids = toolEntityIds(toolName, textFromContent(message.content), call?.args ?? {});
        for (const id of ids) latestToolEntityResult.set(`${toolName}:${id}`, index);
      }
    }

    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type !== "toolCall") continue;
        const toolName = String(block.name ?? "");
        if (toolName !== "edit" && toolName !== "write") continue;
        const path = normalizePath(block.arguments?.path);
        if (path) latestMutationByPath.set(path, index);
      }
    }
  });

  const contextFingerprints: OutputFingerprint[] = [];
  const seenChunks = new Map<string, ChunkSeen>();
  const seenEntities = new Map<string, EntitySeen>();
  let touched = turnOmitted.touched;

  return messages.map((message, index) => {
    // Keep the very recent tail pristine so active tool-use protocol stays high fidelity.
    if (index >= recentStart) return message;

    const manual = isSafeManualOmissionCandidate(message) ? manualOmissions.get(messageOmissionHash(message)) : undefined;
    if (manual) {
      const replacement = manualOmissionReplacement(manual);
      const saved = Math.max(0, roughMessageChars(message) - replacement.length);
      stats.manualContextOmissions++;
      recordSavings(saved, "savedManualOmissionChars");
      touched++;
      return cloneWithText(message, replacement);
    }

    let current = message;

    const thinking = fullMode ? pruneAssistantThinking(current) : { message: current, saved: 0, dropped: 0 };
    if (thinking.dropped > 0) {
      current = thinking.message;
      stats.thinkingBlocksDropped += thinking.dropped;
      recordSavings(thinking.saved, "savedThinkingChars");
      touched++;
    }

    const assistant = fullMode
      ? pruneAssistantContext(current, index, latestEntityIndex, seenEntities, successfulToolCallIds)
      : { message: current, saved: 0, savedEntity: 0, savedToolArgs: 0, touched: false, entityPruned: 0, toolArgsPruned: 0, toolCallsCompacted: 0 };
    if (assistant.touched) {
      current = assistant.message;
      stats.contextEntityPruned += assistant.entityPruned;
      stats.contextToolCallArgsPruned += assistant.toolArgsPruned;
      stats.contextToolCallsCompacted += assistant.toolCallsCompacted;
      recordSavings(assistant.savedEntity, "savedEntityChars");
      recordSavings(assistant.savedToolArgs, "savedToolCallArgChars");
      touched++;
    }

    if (fullMode && (current?.role === "compactionSummary" || current?.role === "branchSummary")) {
      const fullText = String(current.summary ?? "");
      const entityPruned = pruneEntityText(fullText, current.role, index, latestEntityIndex, seenEntities);
      if (entityPruned.pruned) {
        stats.contextEntityPruned++;
        touched++;
        recordSavings(entityPruned.saved, "savedEntityChars");
        recordEntityFamilySavings(extractEntityIds(fullText), entityPruned.saved);
        return { ...current, summary: entityPruned.text };
      }
      return current;
    }

    if (fullMode && current?.role === "user") {
      const fullText = textFromContent(current.content);
      if (!fullText) return current;
      const entityPruned = pruneEntityText(fullText, "user message", index, latestEntityIndex, seenEntities);
      if (entityPruned.pruned) {
        stats.contextEntityPruned++;
        touched++;
        recordSavings(entityPruned.saved, "savedEntityChars");
        recordEntityFamilySavings(extractEntityIds(fullText), entityPruned.saved);
        return cloneWithText(current, entityPruned.text);
      }
      return current;
    }

    if (current?.role === "custom") {
      const label = `custom:${current.customType ?? "message"}`;
      const fullText = textFromContent(current.content);
      if (!fullText) return current;

      const structuredNotice = fullMode
        ? pruneStructuredEntityNotice(fullText, label, index, latestEntityIndex)
        : { text: fullText, saved: 0, pruned: false, strippedBoilerplate: false };
      if (structuredNotice.pruned) {
        stats.contextCustomMessagesPruned++;
        const entityCompacted = structuredNotice.text.startsWith("[cprune: older structured ");
        if (entityCompacted) stats.contextEntityPruned++;
        touched++;
        recordSavings(structuredNotice.saved, entityCompacted ? "savedEntityChars" : "savedCustomChars");
        if (entityCompacted) recordEntityFamilySavings(extractEntityIds(fullText), structuredNotice.saved);
        return cloneWithText(current, structuredNotice.text);
      }

      const entityPruned = fullMode
        ? pruneEntityText(fullText, label, index, latestEntityIndex, seenEntities)
        : { text: fullText, saved: 0, pruned: false };
      if (entityPruned.pruned) {
        stats.contextEntityPruned++;
        stats.contextCustomMessagesPruned++;
        touched++;
        recordSavings(entityPruned.saved, "savedEntityChars");
        recordEntityFamilySavings(extractEntityIds(fullText), entityPruned.saved);
        return cloneWithText(current, entityPruned.text);
      }

      if (fullText.length >= config.minDuplicateChars) {
        const hash = hashText(fullText);
        const exact = contextFingerprints.find((fp) => fp.hash === hash && fp.toolName === label);
        if (exact) {
          stats.contextDuplicates++;
          stats.contextCustomMessagesPruned++;
          touched++;
          recordSavings(Math.max(0, fullText.length - 170), "savedCustomChars");
          return cloneWithText(
            current,
            `[cprune: duplicate ${label} message omitted; same content appeared earlier at message index ${exact.index}; hash=${shortHash(hash)}.]`,
          );
        }

        const appended = findAppendedOutput(fullText, label, contextFingerprints);
        if (appended) {
          const replacement = appendedReplacement(fullText, label, appended);
          stats.contextAppendPruned++;
          stats.contextCustomMessagesPruned++;
          touched++;
          recordSavings(replacement.saved, "savedCustomChars");
          rememberContextFingerprint(contextFingerprints, hash, index, label, fullText);
          return cloneWithText(current, replacement.text);
        }

        rememberContextFingerprint(contextFingerprints, hash, index, label, fullText);
      }

      const chunked = pruneRepeatedLineChunks(fullText, label, index, seenChunks);
      if (chunked.pruned > 0) {
        stats.contextChunkPruned += chunked.pruned;
        stats.contextCustomMessagesPruned++;
        touched++;
        recordSavings(chunked.saved, "savedChunkChars");
        return cloneWithText(current, chunked.text);
      }

      const truncated = truncateMiddle(fullText, config.maxContextCustomMessageChars, `${label} message in request context`);
      if (truncated.saved > 0) {
        stats.contextTruncations++;
        stats.contextCustomMessagesPruned++;
        touched++;
        recordSavings(truncated.saved, "savedCustomChars");
        return cloneWithText(current, truncated.text);
      }

      return current;
    }

    if (current?.role !== "toolResult") return current;

    const call = calls.get(current.toolCallId);
    const toolName = call?.name ?? current.toolName ?? "tool";
    const fullText = textFromContent(current.content);
    if (!fullText) return current;

    const ids = toolEntityIds(toolName, fullText, call?.args ?? {});
    if (fullMode && !current.isError && ids.length > 0 && fullText.length >= config.minSupersededToolResultChars) {
      const latestForSameToolEntity = Math.max(...ids.map((id) => latestToolEntityResult.get(`${toolName}:${id}`) ?? index));
      if (latestForSameToolEntity > index) {
        const hash = hashText(normalizeEntityText(fullText) || fullText);
        const replacement = `[cprune: superseded ${toolName} result omitted; entities=${ids.join(",")}; newer ${toolName} result appears at message index ${latestForSameToolEntity}; hash=${shortHash(hash)}; original=${fullText.length} chars. Re-run/show entity for full current state.]`;
        stats.contextSupersededToolResults++;
        touched++;
        recordSavings(Math.max(0, fullText.length - replacement.length), "savedSupersededToolResultChars");
        recordEntityFamilySavings(ids, Math.max(0, fullText.length - replacement.length));
        return cloneWithText(current, replacement);
      }
    }

    const entityPruned = fullMode
      ? pruneEntityText(fullText, `${toolName} result`, index, latestEntityIndex, seenEntities)
      : { text: fullText, saved: 0, pruned: false };
    if (entityPruned.pruned) {
      stats.contextEntityPruned++;
      touched++;
      recordSavings(entityPruned.saved, "savedEntityChars");
      recordEntityFamilySavings(extractEntityIds(fullText), entityPruned.saved);
      return cloneWithText(current, entityPruned.text);
    }

    // Stale file reads: an older read is superseded by a newer read of the same file
    // or by a later edit/write call to that file.
    if (fullMode && toolName === "read") {
      const path = normalizePath(call?.args.path);
      if (path) {
        const newerRead = latestReadByPath.get(path);
        const laterMutation = latestMutationByPath.get(path);
        if ((newerRead !== undefined && newerRead > index) || (laterMutation !== undefined && laterMutation > index)) {
          const reason = newerRead !== undefined && newerRead > index ? "newer read exists" : "later edit/write exists";
          stats.contextStaleReads++;
          touched++;
          recordSavings(Math.max(0, fullText.length - 120), "savedStaleReadChars");
          return cloneWithText(
            current,
            `[cprune: stale read result omitted for ${path}; ${reason}. Re-read the file if exact old contents are needed.]`,
          );
        }
      }
    }

    // Superseded read-only snapshot commands. If an old `rg`, `find`, `ls`,
    // `git status`, etc. command was run again later, the newer snapshot is
    // usually the one that matters. Keep structure, omit the old bulk.
    if (fullMode && toolName === "bash" && isSnapshotCommand(call?.args.command)) {
      const command = String(call?.args.command).trim();
      const newerRun = latestSnapshotCommand.get(command);
      if (newerRun !== undefined && newerRun > index) {
        stats.contextSupersededCommands++;
        touched++;
        recordSavings(Math.max(0, fullText.length - 180), "savedSupersededCommandChars");
        return cloneWithText(
          current,
          `[cprune: superseded ${toolName} result omitted; command was run again at message index ${newerRun}. Command: ${command}]`,
        );
      }
    }

    // Duplicate or append-only tool outputs in the request context.
    if (fullText.length >= config.minDuplicateChars) {
      const hash = hashText(fullText);
      const exact = contextFingerprints.find((fp) => fp.hash === hash);
      if (exact) {
        stats.contextDuplicates++;
        touched++;
        recordSavings(Math.max(0, fullText.length - 160), "savedDuplicateChars");
        return cloneWithText(
          current,
          `[cprune: duplicate ${toolName} result omitted; same output appeared earlier at message index ${exact.index}; hash=${shortHash(hash)}.]`,
        );
      }

      const appended = findAppendedOutput(fullText, toolName, contextFingerprints);

      if (appended) {
        const replacement = appendedReplacement(fullText, toolName, appended);
        stats.contextAppendPruned++;
        touched++;
        recordSavings(replacement.saved, "savedAppendChars");
        rememberContextFingerprint(contextFingerprints, hash, index, toolName, fullText);
        return cloneWithText(current, replacement.text);
      }

      rememberContextFingerprint(contextFingerprints, hash, index, toolName, fullText);
    }

    // Repeated line chunks catch outputs that are mostly repeated but have changes
    // inserted in the middle, where prefix/contained whole-output matching misses.
    const chunked = pruneRepeatedLineChunks(fullText, toolName, index, seenChunks);
    if (chunked.pruned > 0) {
      stats.contextChunkPruned += chunked.pruned;
      touched++;
      recordSavings(chunked.saved, "savedChunkChars");
      return cloneWithText(current, chunked.text);
    }

    // Oversized old tool outputs.
    const limit = toolName === "bash" ? config.maxContextToolResultChars + 2_000 : config.maxContextToolResultChars;
    const truncated = truncateMiddle(fullText, limit, `${toolName} result in request context`);
    if (truncated.saved > 0) {
      stats.contextTruncations++;
      touched++;
      recordSavings(truncated.saved, "savedTruncationChars");
      return cloneWithText(current, truncated.text);
    }

    return current;
  }).map((message) => {
    // Update once per pass without doing another traversal.
    return message;
  }).filter((message, _index, all) => {
    if (_index === all.length - 1) stats.contextMessagesTouched += touched;
    return true;
  });
}

function cloneStats(): CpruneStats {
  return {
    ...stats,
    entityFamilyPruned: { ...stats.entityFamilyPruned },
    entityFamilySavedChars: { ...stats.entityFamilySavedChars },
  };
}

function restoreStats(snapshot: CpruneStats) {
  Object.assign(stats, snapshot);
  stats.entityFamilyPruned = { ...snapshot.entityFamilyPruned };
  stats.entityFamilySavedChars = { ...snapshot.entityFamilySavedChars };
}

function diffRecord(after: Record<string, number>, before: Record<string, number>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of new Set([...Object.keys(after), ...Object.keys(before)])) {
    const delta = (after[key] ?? 0) - (before[key] ?? 0);
    if (delta !== 0) result[key] = delta;
  }
  return result;
}

function roughMessageChars(message: AnyMessage): number {
  if (!message) return 0;

  if (message.role === "user" || message.role === "toolResult" || message.role === "custom") {
    return textFromContent(message.content).length || safeJson(message).length;
  }

  if (message.role === "assistant" && Array.isArray(message.content)) {
    return message.content
      .map((block: any) => {
        if (block?.type === "text") return block.text?.length ?? 0;
        if (block?.type === "thinking") return block.thinking?.length ?? 0;
        if (block?.type === "toolCall") return safeJson(block, 10_000).length;
        return safeJson(block, 10_000).length;
      })
      .reduce((sum: number, n: number) => sum + n, 0);
  }

  if (message.role === "compactionSummary") return String(message.summary ?? "").length;
  if (message.role === "branchSummary") return String(message.summary ?? "").length;
  if (message.role === "bashExecution") return String(message.command ?? "").length + String(message.output ?? "").length;

  return safeJson(message, 50_000).length;
}

function stableMessageText(message: AnyMessage): string {
  if (!message) return "";
  if (message.role === "assistant" && Array.isArray(message.content)) {
    return message.content
      .map((block: any) => {
        if (block?.type === "text") return block.text ?? "";
        if (block?.type === "thinking") return block.thinking ?? "";
        if (block?.type === "toolCall") return safeJson(block, 20_000);
        return safeJson(block, 20_000);
      })
      .join("\n");
  }
  if (message.role === "compactionSummary" || message.role === "branchSummary") return String(message.summary ?? "");
  if (message.role === "bashExecution") return `${message.command ?? ""}\n${message.output ?? ""}`;
  return textFromContent(message.content) || safeJson(message, 50_000);
}

function messageOmissionHash(message: AnyMessage): string {
  return hashText(`${message?.role ?? "unknown"}\n${stableMessageText(message)}`);
}

function messageLabel(message: AnyMessage, index: number): string {
  if (message?.role === "toolResult") return `#${index} tool result`;
  if (message?.role === "assistant") return `#${index} assistant`;
  if (message?.role === "user") return `#${index} user`;
  if (message?.role === "custom") return `#${index} custom:${message.customType ?? "message"}`;
  if (message?.role === "compactionSummary") return `#${index} compaction summary`;
  if (message?.role === "branchSummary") return `#${index} branch summary`;
  return `#${index} ${message?.role ?? "message"}`;
}

function manualOmissionReplacement(omission: ManualOmission): string {
  return `[cprune: user-excluded context omitted; label=${omission.label}; hash=${shortHash(omission.hash)}; original=${omission.chars} chars; preview=${JSON.stringify(omission.preview)}.]`;
}

function turnOmissionHash(turnMessages: AnyMessage[]): string {
  return hashText(`turn\n${turnMessages.map(stableMessageText).join("\n---\n")}`);
}

function isVisibleShellExecution(message: AnyMessage): boolean {
  return message?.role === "bashExecution" && message.excludeFromContext !== true;
}

function isPromptReviewStart(message: AnyMessage): boolean {
  return message?.role === "user" || isVisibleShellExecution(message);
}

function manualTurnOmissionReplacement(omission: ManualTurnOmission, actualChars: number): string {
  return `[cprune: user-excluded prompt/response turn omitted; label=${omission.label}; hash=${shortHash(omission.hash)}; messages=${omission.messageCount}; original=${actualChars} chars; preview=${JSON.stringify(omission.preview)}.]`;
}

function applyManualTurnOmissions(messages: AnyMessage[]): { messages: AnyMessage[]; touched: number } {
  if (manualTurnOmissions.size === 0) return { messages, touched: 0 };

  const result: AnyMessage[] = [];
  let touched = 0;
  for (let index = 0; index < messages.length; ) {
    const message = messages[index];
    if (!isPromptReviewStart(message)) {
      result.push(message);
      index++;
      continue;
    }

    let end = index + 1;
    if (!isVisibleShellExecution(message)) {
      while (end < messages.length && !isPromptReviewStart(messages[end])) end++;
    }

    const omitted = messages.slice(index, end);
    const omission = manualTurnOmissions.get(turnOmissionHash(omitted));
    if (!omission) {
      result.push(message);
      index++;
      continue;
    }
    const actualChars = omitted.reduce((sum, item) => sum + roughMessageChars(item), 0);
    const replacement = manualTurnOmissionReplacement(omission, actualChars);
    result.push({ role: "user", content: textContent(replacement) });
    stats.manualContextOmissions++;
    recordSavings(Math.max(0, actualChars - replacement.length), "savedManualOmissionChars");
    touched++;
    index = end;
  }

  return { messages: result, touched };
}

function contextSize(messages: AnyMessage[]) {
  const chars = messages.reduce((sum, message) => sum + roughMessageChars(message), 0);
  return {
    messages: messages.length,
    chars,
    approxTokens: Math.ceil(chars / 4),
  };
}

type Breakdown = Record<string, number>;

function addBreakdown(target: Breakdown, label: string, chars: number) {
  if (chars <= 0) return;
  target[label] = (target[label] ?? 0) + chars;
}

function contextBreakdown(messages: AnyMessage[]): Breakdown {
  const result: Breakdown = {};

  for (const message of messages) {
    if (!message) continue;

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "text") addBreakdown(result, "assistant text", String(block.text ?? "").length);
        else if (block?.type === "thinking") addBreakdown(result, "assistant thinking", String(block.thinking ?? "").length);
        else if (block?.type === "toolCall") addBreakdown(result, "tool calls", safeJson(block, 50_000).length);
        else addBreakdown(result, "assistant other", safeJson(block, 50_000).length);
      }
      continue;
    }

    if (message.role === "toolResult") {
      addBreakdown(result, "tool results", roughMessageChars(message));
      continue;
    }

    if (message.role === "user") {
      addBreakdown(result, "user messages", roughMessageChars(message));
      continue;
    }

    if (message.role === "custom") {
      addBreakdown(result, "custom messages", roughMessageChars(message));
      continue;
    }

    if (message.role === "compactionSummary" || message.role === "branchSummary") {
      addBreakdown(result, "summaries", roughMessageChars(message));
      continue;
    }

    if (message.role === "bashExecution") {
      addBreakdown(result, "bash executions", roughMessageChars(message));
      continue;
    }

    addBreakdown(result, "other", roughMessageChars(message));
  }

  return result;
}

function currentContextMessages(ctx: any): AnyMessage[] {
  const built = ctx.sessionManager?.buildSessionContext?.();
  if (Array.isArray(built?.messages)) return built.messages;

  // Fallback for older SDK shapes. This is less exact because it does not convert
  // compaction/custom entries, but keeps /cprune useful.
  const branch = ctx.sessionManager?.getBranch?.() ?? [];
  return branch
    .map((entry: any) => {
      if (entry.type === "message") return entry.message;
      if (entry.type === "custom_message") {
        return { role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details: entry.details };
      }
      if (entry.type === "compaction") return { role: "compactionSummary", summary: entry.summary };
      if (entry.type === "branch_summary") return { role: "branchSummary", summary: entry.summary };
      return undefined;
    })
    .filter(Boolean);
}

function fmtInt(value: number): string {
  return value.toLocaleString();
}

function fmtPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

const PARTIAL_BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const BRIGHT_TEXT = "\x1b[22m\x1b[39m";

function blockBar(value: number, max: number, width: number): { filled: string; padding: string } {
  if (max <= 0 || value <= 0) return { filled: "", padding: " ".repeat(width) };

  const scaled = Math.max(0, Math.min(width, (value / max) * width));
  let full = Math.floor(scaled);
  let eighth = Math.round((scaled - full) * 8);
  if (eighth === 8) {
    full++;
    eighth = 0;
  }
  full = Math.min(full, width);
  if (full === width) eighth = 0;

  const partial = PARTIAL_BLOCKS[eighth] ?? "";
  const usedCells = full + (partial ? 1 : 0);
  return {
    filled: `${"█".repeat(full)}${partial}`,
    padding: " ".repeat(Math.max(0, width - usedCells)),
  };
}

function bar(value: number, max: number, width = 32): string {
  const { filled, padding } = blockBar(value, max, width);
  return `${filled}${padding}`;
}

function colorBar(value: number, max: number, kind: "off" | "safe" | "full" | "before" | "after", width = 24): string {
  const { filled, padding } = blockBar(value, max, width);
  if (!filled) return padding;

  // Use simple SGR color codes only. cprune never writes to stdout/stderr; this
  // string is returned through Pi's normal UI/tool surfaces. The earlier MCP
  // lifecycle line was from context-mode, not these bars.
  const color = kind === "off" || kind === "before" ? "\x1b[31m" : kind === "safe" ? "\x1b[38;5;208m" : "\x1b[32m";
  const reset = "\x1b[0m";
  return `${color}${filled}${reset}${padding}`;
}

function breakdownLines(before: Breakdown, after: Breakdown): string[] {
  const labels = [
    "tool results",
    "assistant thinking",
    "assistant text",
    "tool calls",
    "custom messages",
    "user messages",
    "summaries",
    "bash executions",
    "assistant other",
    "other",
  ];
  const present = labels.filter((label) => (before[label] ?? 0) > 0 || (after[label] ?? 0) > 0);
  const dynamic = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((label) => !labels.includes(label))
    .sort();
  const ordered = [...present, ...dynamic];
  const max = Math.max(1, ...ordered.map((label) => Math.max(before[label] ?? 0, after[label] ?? 0)));

  return ordered.flatMap((label) => {
    const b = before[label] ?? 0;
    const a = after[label] ?? 0;
    const saved = Math.max(0, b - a);
    return [
      `  ${label.padEnd(20)} ${colorBar(b, max, "off", 12)} ${fmtInt(b).padStart(10)} chars`,
      `  ${"".padEnd(20)} ${colorBar(a, max, "full", 12)} ${fmtInt(a).padStart(10)} chars  saved ${fmtInt(saved)}`,
    ];
  });
}

function triBreakdownLines(off: Breakdown, safe: Breakdown, full: Breakdown): string[] {
  const labels = [
    "tool results",
    "assistant thinking",
    "assistant text",
    "tool calls",
    "custom messages",
    "user messages",
    "summaries",
    "bash executions",
    "assistant other",
    "other",
  ];
  const dynamic = [...new Set([...Object.keys(off), ...Object.keys(safe), ...Object.keys(full)])]
    .filter((label) => !labels.includes(label))
    .sort();
  const ordered = [...labels, ...dynamic].filter(
    (label) => (off[label] ?? 0) > 0 || (safe[label] ?? 0) > 0 || (full[label] ?? 0) > 0,
  );
  const max = Math.max(1, ...ordered.map((label) => Math.max(off[label] ?? 0, safe[label] ?? 0, full[label] ?? 0)));

  return ordered.flatMap((label) => {
    const o = off[label] ?? 0;
    const s = safe[label] ?? 0;
    const f = full[label] ?? 0;
    return [
      `  ${label.padEnd(20)} ${colorBar(o, max, "off", 12)} ${fmtInt(o).padStart(10)} chars  off`,
      `  ${"".padEnd(20)} ${colorBar(s, max, "safe", 12)} ${fmtInt(s).padStart(10)} chars  safe saved ${fmtInt(Math.max(0, o - s))}`,
      `  ${"".padEnd(20)} ${colorBar(f, max, "full", 12)} ${fmtInt(f).padStart(10)} chars  full saved ${fmtInt(Math.max(0, o - f))}`,
    ];
  });
}

function simulatePrunedContext(ctx: any, pruneMode: CpruneMode) {
  const rawMessages = currentContextMessages(ctx);
  const before = contextSize(rawMessages);

  const snapshot = cloneStats();
  const prunedMessages = pruneContextMessages(rawMessages, pruneMode);
  const passDelta = {
    staleReads: stats.contextStaleReads - snapshot.contextStaleReads,
    duplicates: stats.contextDuplicates - snapshot.contextDuplicates,
    appendPruned: stats.contextAppendPruned - snapshot.contextAppendPruned,
    supersededCommands: stats.contextSupersededCommands - snapshot.contextSupersededCommands,
    supersededToolResults: stats.contextSupersededToolResults - snapshot.contextSupersededToolResults,
    chunks: stats.contextChunkPruned - snapshot.contextChunkPruned,
    customMessages: stats.contextCustomMessagesPruned - snapshot.contextCustomMessagesPruned,
    entities: stats.contextEntityPruned - snapshot.contextEntityPruned,
    toolCallArgs: stats.contextToolCallArgsPruned - snapshot.contextToolCallArgsPruned,
    truncations: stats.contextTruncations - snapshot.contextTruncations,
    manualOmissions: stats.manualContextOmissions - snapshot.manualContextOmissions,
    thinkingBlocks: stats.thinkingBlocksDropped - snapshot.thinkingBlocksDropped,
    touched: stats.contextMessagesTouched - snapshot.contextMessagesTouched,
    saved: stats.approxCharsSaved - snapshot.approxCharsSaved,
    savedThinking: stats.savedThinkingChars - snapshot.savedThinkingChars,
    savedStaleReads: stats.savedStaleReadChars - snapshot.savedStaleReadChars,
    savedDuplicates: stats.savedDuplicateChars - snapshot.savedDuplicateChars,
    savedAppend: stats.savedAppendChars - snapshot.savedAppendChars,
    savedSupersededCommands: stats.savedSupersededCommandChars - snapshot.savedSupersededCommandChars,
    savedSupersededToolResults: stats.savedSupersededToolResultChars - snapshot.savedSupersededToolResultChars,
    savedChunks: stats.savedChunkChars - snapshot.savedChunkChars,
    savedCustom: stats.savedCustomChars - snapshot.savedCustomChars,
    savedEntities: stats.savedEntityChars - snapshot.savedEntityChars,
    savedToolCallArgs: stats.savedToolCallArgChars - snapshot.savedToolCallArgChars,
    savedTruncations: stats.savedTruncationChars - snapshot.savedTruncationChars,
    savedManualOmissions: stats.savedManualOmissionChars - snapshot.savedManualOmissionChars,
    entityFamilyPruned: diffRecord(stats.entityFamilyPruned, snapshot.entityFamilyPruned),
    entityFamilySavedChars: diffRecord(stats.entityFamilySavedChars, snapshot.entityFamilySavedChars),
  };
  restoreStats(snapshot);

  return {
    mode: pruneMode,
    before,
    after: contextSize(prunedMessages),
    beforeBreakdown: contextBreakdown(rawMessages),
    afterBreakdown: contextBreakdown(prunedMessages),
    passDelta,
  };
}

function contextStatText(ctx: any): string {
  const off = simulatePrunedContext(ctx, "off");
  const safe = simulatePrunedContext(ctx, "safe");
  const full = simulatePrunedContext(ctx, "full");
  const usage = ctx.getContextUsage?.();
  const modelUsage = usage
    ? `${usage.tokens ?? "unknown"}/${usage.contextWindow} tokens (${usage.percent?.toFixed(1) ?? "?"}%)`
    : "unknown";

  const safeSaved = Math.max(0, off.before.chars - safe.after.chars);
  const fullSaved = Math.max(0, off.before.chars - full.after.chars);
  const safePct = off.before.chars > 0 ? (safeSaved / off.before.chars) * 100 : 0;
  const fullPct = off.before.chars > 0 ? (fullSaved / off.before.chars) * 100 : 0;

  return [
    `${BRIGHT_TEXT}cprune`,
    "",
    "Summary",
    `  active mode       : ${mode}`,
    `  model context     : ${modelUsage}`,
    `  messages          : ${fmtInt(off.before.messages)} total, safe touches ${fmtInt(safe.passDelta.touched)}, full touches ${fmtInt(full.passDelta.touched)}`,
    `  user exclusions   : ${fmtInt(manualOmissions.size + manualTurnOmissions.size)}`,
    `  persisted savings : ${fmtInt(stats.approxCharsSaved)} chars; tool results dup/norm/append/trunc ${fmtInt(stats.toolResultsDeduped)}/${fmtInt(stats.toolResultsNormalizedDeduped)}/${fmtInt(stats.toolResultsAppendPruned)}/${fmtInt(stats.toolResultsTruncated)}`,
    "",
    "Mode comparison",
    `  off   ${colorBar(off.before.chars, off.before.chars, "off")} ${fmtInt(off.before.chars)} chars  ~${fmtInt(off.before.approxTokens)} tok  0 saved`,
    `  safe  ${colorBar(safe.after.chars, off.before.chars, "safe")} ${fmtInt(safe.after.chars)} chars  ~${fmtInt(safe.after.approxTokens)} tok  saved ${fmtInt(safeSaved)} (${fmtPct(safePct)})`,
    `  full  ${colorBar(full.after.chars, off.before.chars, "full")} ${fmtInt(full.after.chars)} chars  ~${fmtInt(full.after.approxTokens)} tok  saved ${fmtInt(fullSaved)} (${fmtPct(fullPct)})`,
    "",
    "Breakdown by context part (off / safe / full)",
    ...triBreakdownLines(off.beforeBreakdown, safe.afterBreakdown, full.afterBreakdown),
  ].join("\n");
}

type ReviewCandidate = {
  index: number;
  hash: string;
  label: string;
  role: string;
  chars: number;
  ids: string[];
  preview: string;
};

function isSafeManualOmissionCandidate(message: AnyMessage): boolean {
  // Avoid user-directed omission of historical assistant tool-call containers: some
  // providers expect old tool results to remain paired with their tool-call blocks.
  // cprune can still compact their large arguments with protocol-aware rules.
  return !(message?.role === "assistant" && Array.isArray(message.content) && message.content.some((block: any) => block?.type === "toolCall"));
}

function largeContextCandidates(ctx: any): ReviewCandidate[] {
  const messages = currentContextMessages(ctx);
  const recentStart = Math.max(0, messages.length - config.keepRecentMessagesUntouched);
  return messages
    .map((message, index): ReviewCandidate | undefined => {
      if (index >= recentStart) return undefined;
      if (!isSafeManualOmissionCandidate(message)) return undefined;
      const text = stableMessageText(message);
      const chars = roughMessageChars(message);
      if (chars < 800 || !text.trim()) return undefined;
      const hash = messageOmissionHash(message);
      if (manualOmissions.has(hash)) return undefined;
      return {
        index,
        hash,
        label: messageLabel(message, index),
        role: String(message?.role ?? "message"),
        chars,
        ids: extractEntityIds(text),
        preview: previewEntityText(text, 180),
      };
    })
    .filter((item): item is ReviewCandidate => Boolean(item))
    .sort((a, b) => b.chars - a.chars)
    .slice(0, config.maxReviewCandidates);
}

function reviewCandidateOption(candidate: ReviewCandidate): string {
  const ids = candidate.ids.length ? ` ${candidate.ids.slice(0, 4).join(",")}` : "";
  return `${fmtInt(candidate.chars).padStart(8)} chars | ${candidate.label}${ids} | ${candidate.preview.replace(/\s+/g, " ").slice(0, 90)}`;
}

type TurnCandidate = {
  start: number;
  end: number;
  hash: string;
  label: string;
  chars: number;
  messageCount: number;
  preview: string;
};

type ReviewPromptMode = "safe" | "full";

function reviewHistoryMessages(ctx: any, mode: ReviewPromptMode): AnyMessage[] {
  const branch = ctx.sessionManager?.getBranch?.();
  if (!Array.isArray(branch) || branch.length === 0) return currentContextMessages(ctx);
  return branch
    .map((entry: any) => {
      if (entry.type === "message") return entry.message;
      if (entry.type === "custom_message") {
        return { role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details: entry.details };
      }
      if (entry.type === "compaction") return { role: "compactionSummary", summary: entry.summary };
      if (entry.type === "branch_summary") return { role: "branchSummary", summary: entry.summary };
      return undefined;
    })
    // Safe mode mirrors Pi prompt behavior by hiding `!!cmd` shell entries with
    // excludeFromContext=true. Full mode shows raw branch history, including them.
    .filter((message: any) => Boolean(message) && (mode === "full" || !(message.role === "bashExecution" && message.excludeFromContext === true)));
}

function isPromptReviewShellExecution(message: AnyMessage, mode: ReviewPromptMode): boolean {
  return message?.role === "bashExecution" && (mode === "full" || message.excludeFromContext !== true);
}

function isPromptReviewStartInMode(message: AnyMessage, mode: ReviewPromptMode): boolean {
  return message?.role === "user" || isPromptReviewShellExecution(message, mode);
}

function turnCandidates(ctx: any, limit: number, mode: ReviewPromptMode): TurnCandidate[] {
  const messages = reviewHistoryMessages(ctx, mode);
  const starts = messages
    .map((message, index) => (isPromptReviewStartInMode(message, mode) ? index : -1))
    .filter((index) => index >= 0)
    .slice(-Math.max(1, limit));

  return starts
    .map((start): TurnCandidate | undefined => {
      let end = start + 1;
      if (!isPromptReviewShellExecution(messages[start], mode)) {
        while (end < messages.length && !isPromptReviewStartInMode(messages[end], mode)) end++;
      }
      const turn = messages.slice(start, end);
      const userText = stableMessageText(messages[start]).trim();
      if (!userText) return undefined;
      const hash = turnOmissionHash(turn);
      if (manualTurnOmissions.has(hash)) return undefined;
      const chars = turn.reduce((sum, message) => sum + roughMessageChars(message), 0);
      return {
        start,
        end: end - 1,
        hash,
        label: isPromptReviewShellExecution(messages[start], mode)
          ? `#${start} ${messages[start].excludeFromContext === true ? "hidden shell command" : "shell command"}`
          : `#${start} prompt/response turn`,
        chars,
        messageCount: turn.length,
        preview: previewEntityText(userText, 180),
      };
    })
    .filter((item): item is TurnCandidate => Boolean(item))
    .reverse();
}

function turnCandidateOption(candidate: TurnCandidate): string {
  return `${fmtInt(candidate.chars).padStart(8)} chars | #${candidate.start}-${candidate.end} ${candidate.messageCount} msgs | ${candidate.preview.replace(/\s+/g, " ").slice(0, 100)}`;
}

async function reviewCommandTurns(ctx: any, pi: ExtensionAPI, limit: number, startPage = 1, mode: ReviewPromptMode = "safe") {
  const candidates = turnCandidates(ctx, limit, mode);
  if (candidates.length === 0) {
    ctx.ui.notify(`cprune: no prompt/response turns found in last ${limit} prompts (${mode} mode)`, "info");
    return;
  }

  const pageSize = config.reviewCommandPageSize;
  let page = Math.max(0, Math.min(Math.ceil(candidates.length / pageSize) - 1, startPage - 1));

  while (true) {
    const start = page * pageSize;
    const pageCandidates = candidates.slice(start, start + pageSize);
    const totalPages = Math.max(1, Math.ceil(candidates.length / pageSize));
    const candidateOptions = pageCandidates.map(turnCandidateOption);
    const options = [...candidateOptions];
    if (page > 0) options.push("← Previous newer prompts");
    if (start + pageSize < candidates.length) options.push("Next older prompts →");
    options.push("Cancel");

    const choice = await ctx.ui.select(
      `cprune: choose a prompt/response turn to exclude (${mode} mode, page ${page + 1}/${totalPages}, last ${limit} prompts)`,
      options,
    );
    if (!choice || choice === "Cancel") return;
    if (choice === "← Previous newer prompts") {
      page = Math.max(0, page - 1);
      continue;
    }
    if (choice === "Next older prompts →") {
      page = Math.min(totalPages - 1, page + 1);
      continue;
    }

    const index = candidateOptions.indexOf(choice);
    const candidate = pageCandidates[index];
    if (!candidate) return;

    const ok = await ctx.ui.confirm(
      "Exclude this prompt/response turn?",
      `${candidate.label}\nmessages #${candidate.start}-${candidate.end}\n${fmtInt(candidate.chars)} chars\n\nThis is non-destructive: cprune will omit the selected user prompt and its response/tool-results at prompt time, but it will not rewrite Pi session history.`,
    );
    if (!ok) continue;

    manualTurnOmissions.set(candidate.hash, {
      hash: candidate.hash,
      label: candidate.label,
      chars: candidate.chars,
      messageCount: candidate.messageCount,
      preview: candidate.preview,
      createdAt: Date.now(),
    });
    saveState(pi);
    ctx.ui.notify(`cprune: excluded ${candidate.label} from future prompts`, "info");
    return;
  }
}

async function reviewLargeContext(ctx: any, pi: ExtensionAPI) {
  const candidates = largeContextCandidates(ctx);
  if (candidates.length === 0) {
    ctx.ui.notify("cprune: no large older context candidates found", "info");
    return;
  }

  const options = candidates.map(reviewCandidateOption);
  options.push("Cancel");
  const choice = await ctx.ui.select("cprune: choose an older context entry to exclude from future model prompts", options);
  if (!choice || choice === "Cancel") return;

  const index = options.indexOf(choice);
  const candidate = candidates[index];
  if (!candidate) return;

  const ok = await ctx.ui.confirm(
    "Exclude from future prompts?",
    `${candidate.label}\n${fmtInt(candidate.chars)} chars\n\nThis is non-destructive: cprune will omit this entry at prompt time, but it will not rewrite Pi session history.`,
  );
  if (!ok) return;

  manualOmissions.set(candidate.hash, {
    hash: candidate.hash,
    label: candidate.label,
    role: candidate.role,
    chars: candidate.chars,
    preview: candidate.preview,
    createdAt: Date.now(),
  });
  saveState(pi);
  ctx.ui.notify(`cprune: excluded ${candidate.label} from future prompts`, "info");
}

function cpruneCompactInstructions(reason: string): string {
  return `cprune ${reason}: create a compact continuation summary that removes duplicate/stale details. Preserve only information needed to continue safely: current user goal, explicit user instructions, decisions, constraints, modified/read files, entity IDs and latest states, blockers/errors, and next steps. Do not preserve repeated tool outputs, stale file snapshots superseded by newer reads/edits, duplicate entity notifications, or verbose historical comments unless they contain unique current instructions or unresolved errors.`;
}

function maybeTriggerCompaction(ctx: any) {
  if (mode === "off" || !config.autoCompactAtPercent || compactInFlight) return;

  const usage = ctx.getContextUsage?.();
  if (!usage?.percent || usage.percent < config.autoCompactAtPercent) return;

  // ctx.getContextUsage() is based on Pi's unpruned session state. Because cprune
  // prunes at the LLM boundary, only compact when the simulated pruned footprint
  // is also above the threshold. Preserve any model-reported overhead (system
  // prompt/tool schemas/etc.) by adding it back to the pruned message estimate.
  const footprint = simulatePrunedContext(ctx, mode);
  const reportedTokens = typeof usage.tokens === "number" ? usage.tokens : footprint.before.approxTokens;
  const overheadTokens = Math.max(0, reportedTokens - footprint.before.approxTokens);
  const prunedEstimatedTokens = overheadTokens + footprint.after.approxTokens;
  const prunedPercent = usage.contextWindow > 0 ? (prunedEstimatedTokens / usage.contextWindow) * 100 : usage.percent;
  if (prunedPercent < config.autoCompactAtPercent) return;

  const now = Date.now();
  if (now - lastCompactAt < config.compactCooldownMs) return;

  compactInFlight = true;
  lastCompactAt = now;
  stats.compactionsTriggered++;

  ctx.compact({
    customInstructions: cpruneCompactInstructions("background compaction"),
    onComplete: () => {
      compactInFlight = false;
      ctx.ui.notify("cprune: background compaction completed", "info");
    },
    onError: (error: Error) => {
      compactInFlight = false;
      ctx.ui.notify(`cprune: background compaction failed: ${error.message}`, "warning");
    },
  });
}

export default function cprune(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    loadStateFromSession(ctx);
    ctx.ui.setStatus("cprune", `cprune: ${mode}`);
  });

  pi.on("session_shutdown", () => {
    saveState(pi);
  });

  pi.on("tool_result", (event) => {
    if (mode === "off") return;

    stats.toolResultsSeen++;

    const fullText = textFromContent(event.content);
    if (!fullText) return;

    if (fullText.length >= config.minDuplicateChars) {
      const hash = hashText(fullText);
      const duplicate = seenOutputs.get(hash);
      if (duplicate) {
        duplicate.count++;
        stats.toolResultsDeduped++;
        const replacement = `[cprune: duplicate ${event.toolName} result omitted. First seen for ${duplicate.toolName}(${duplicate.input}); hash=${shortHash(hash)}; original length=${fullText.length} chars.]`;
        mergeStats(Math.max(0, fullText.length - replacement.length));
        return {
          content: textContent(replacement),
          details: {
            ...(typeof event.details === "object" && event.details ? event.details : {}),
            cprune: { pruned: "duplicate", hash, originalChars: fullText.length },
          },
        };
      }

      const normalizedDuplicate = findNormalizedDuplicateSeenOutput(fullText, event.toolName);
      if (normalizedDuplicate) {
        stats.toolResultsNormalizedDeduped++;
        const replacement = `[cprune: normalized duplicate ${event.toolName} result omitted. Same content after ANSI/CRLF/trailing-whitespace normalization first seen for ${normalizedDuplicate.prior.toolName}(${normalizedDuplicate.prior.input}); normalizedHash=${shortHash(normalizedDuplicate.fingerprint.normalizedHash)}; rawHash=${shortHash(hash)}; original length=${fullText.length} chars.]`;
        mergeStats(Math.max(0, fullText.length - replacement.length));
        return {
          content: textContent(replacement),
          details: {
            ...(typeof event.details === "object" && event.details ? event.details : {}),
            cprune: {
              pruned: "normalized-duplicate",
              normalizedHash: normalizedDuplicate.fingerprint.normalizedHash,
              hash,
              originalChars: fullText.length,
            },
          },
        };
      }

      const appended = findAppendedSeenOutput(fullText, event.toolName);
      rememberOutput(hash, event.toolName, event.input, fullText.length, fullText);
      if (appended) {
        stats.toolResultsAppendPruned++;
        const replacement = appendedReplacement(fullText, event.toolName, appended);
        mergeStats(replacement.saved);
        return {
          content: textContent(replacement.text),
          details: {
            ...(typeof event.details === "object" && event.details ? event.details : {}),
            cprune: {
              pruned: "appended",
              match: appended.kind,
              prefixHash: appended.prior.hash,
              omittedRepeatedChars: appended.endBoundary - appended.startBoundary,
              originalChars: fullText.length,
            },
          },
        };
      }
    }

    const limit = event.toolName === "bash" ? config.maxPersistedToolResultChars + 4_000 : config.maxPersistedToolResultChars;
    const truncated = persistedTruncation(fullText, limit, event.toolName);
    if (truncated.saved > 0) {
      stats.toolResultsTruncated++;
      mergeStats(truncated.saved);
      return {
        content: textContent(truncated.text),
        details: {
          ...(typeof event.details === "object" && event.details ? event.details : {}),
          cprune: { pruned: "truncated", hash: truncated.hash, originalChars: fullText.length, keptChars: truncated.text.length },
        },
      };
    }
  });

  pi.on("context", (event) => {
    if (mode === "off") return;
    return { messages: pruneContextMessages(event.messages, mode) };
  });

  pi.on("agent_end", (_event, ctx) => {
    maybeTriggerCompaction(ctx);
  });

  pi.registerCommand("cprune", {
    description: "Control cprune: /cprune [off|safe|full|review|review-prompts|compact]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts[0];

      if (!action) {
        ctx.ui.notify(contextStatText(ctx), "info");
        return;
      }

      if (action === "on" || action === "full") {
        mode = "full";
        ctx.ui.setStatus("cprune", "cprune: full");
        saveState(pi);
        ctx.ui.notify("cprune: full pruning enabled", "info");
        return;
      }

      if (action === "safe") {
        mode = "safe";
        ctx.ui.setStatus("cprune", "cprune: safe");
        saveState(pi);
        ctx.ui.notify("cprune: safe pruning enabled", "info");
        return;
      }

      if (action === "off") {
        mode = "off";
        ctx.ui.setStatus("cprune", "cprune: off");
        saveState(pi);
        ctx.ui.notify("cprune: pruning disabled. /cprune still simulates safe/full savings.", "info");
        return;
      }

      if (action === "review") {
        await reviewLargeContext(ctx, pi);
        return;
      }

      if (action === "review-prompts" || action === "review-command" || action === "review-turns") {
        const mode: ReviewPromptMode = parts.includes("full") ? "full" : "safe";
        const numbers = parts
          .slice(1)
          .map((part) => Number(part))
          .filter(Number.isFinite);
        const limit = Number.isFinite(numbers[0]) ? Math.max(1, Math.min(200, Math.floor(numbers[0]))) : 10;
        const page = Number.isFinite(numbers[1]) ? Math.max(1, Math.floor(numbers[1])) : 1;
        await reviewCommandTurns(ctx, pi, limit, page, mode);
        return;
      }

      if (action === "clear-exclusions") {
        const count = manualOmissions.size + manualTurnOmissions.size;
        manualOmissions.clear();
        manualTurnOmissions.clear();
        saveState(pi);
        ctx.ui.notify(`cprune: cleared ${count} user exclusions`, "info");
        return;
      }

      if (action === "compact") {
        ctx.compact({
          customInstructions: cpruneCompactInstructions("manual compaction"),
          onComplete: () => ctx.ui.notify("cprune: compaction completed (lossy summary added)", "info"),
          onError: (error) => ctx.ui.notify(`cprune: compaction failed: ${error.message}`, "warning"),
        });
        return;
      }
      ctx.ui.notify("Usage: /cprune [off|safe|full|review|review-prompts [safe|full] [N] [page]|clear-exclusions|compact]", "warning");
    },
  });

  pi.registerTool({
    name: "cprune_status",
    label: "cprune status",
    description:
      "Control cprune and inspect pruning impact. Omit action to show the off/safe/full comparison; actions set mode or compact.",
    promptSnippet: "Control cprune and report pruning impact",
    promptGuidelines: [
      "Call cprune_status with no action when the user asks whether cprune is saving context or whether pruning is effective.",
      "Use cprune_status with action=\"safe\", action=\"full\", or action=\"off\" when the user asks to set cprune pruning mode.",
      "Use cprune_status with action=\"compact\" when the user asks to persistently compact/prune context via Pi compaction. This is lossy summarization.",
    ],
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union(
          [Type.Literal("on"), Type.Literal("off"), Type.Literal("safe"), Type.Literal("full"), Type.Literal("compact")],
          {
            description:
              "Omit action to compare off/safe/full context. off/safe/full set pruning mode (on aliases full); compact requests persistent cprune-focused lossy compaction.",
          },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action;

      if (action === "on" || action === "full") {
        mode = "full";
        ctx.ui.setStatus("cprune", "cprune: full");
        saveState(pi);
        return { content: textContent("cprune: full pruning enabled"), details: { mode, enabled: true, stats } };
      }

      if (action === "safe") {
        mode = "safe";
        ctx.ui.setStatus("cprune", "cprune: safe");
        saveState(pi);
        return { content: textContent("cprune: safe pruning enabled"), details: { mode, enabled: true, stats } };
      }

      if (action === "off") {
        mode = "off";
        ctx.ui.setStatus("cprune", "cprune: off");
        saveState(pi);
        return {
          content: textContent("cprune: pruning disabled. Calling cprune_status without an action still simulates safe/full savings."),
          details: { mode, enabled: mode !== "off", stats },
        };
      }

      if (action === "compact") {
        ctx.compact({
          customInstructions: cpruneCompactInstructions("tool compaction"),
        });
        return {
          content: textContent("cprune: compact requested (lossy persistent compaction will be added)"),
          details: { mode, enabled: mode !== "off", stats },
        };
      }

      return { content: textContent(contextStatText(ctx)), details: { mode, enabled: mode !== "off", stats, seenOutputHashes: seenOutputs.size } };
    },
  });
}
