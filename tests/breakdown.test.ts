import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "../src/cprune.js";

function sum(values: Record<string, number>): number {
  return Object.values(values).reduce((total, value) => total + value, 0);
}

test("breakdown token allocation sums to the displayed total despite rounding", () => {
  const breakdown = {
    "tool results": 1,
    "assistant thinking": 1,
    "assistant text": 1,
  };
  const labels = __testing.orderedBreakdownLabels(breakdown);
  const totalTokens = __testing.approxTokensFromChars(Object.values(breakdown).reduce((total, chars) => total + chars, 0));
  const allocated = __testing.allocateApproxTokensByLabel(breakdown, labels, totalTokens);

  assert.equal(totalTokens, 1);
  assert.equal(sum(allocated), totalTokens);
});

test("context totals equal the sum of displayed breakdown token buckets", () => {
  const messages = [
    { role: "toolResult", content: [{ type: "text", text: "x".repeat(101) }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t".repeat(73) },
        { type: "text", text: "a".repeat(37) },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/file.ts" } },
      ],
    },
    { role: "user", content: [{ type: "text", text: "u".repeat(19) }] },
    { role: "custom", customType: "example", content: [{ type: "text", text: "c".repeat(29) }] },
    { role: "compactionSummary", summary: "s".repeat(31) },
  ];

  const breakdown = __testing.contextBreakdown(messages);
  const total = __testing.contextSize(messages).approxTokens;
  const labels = __testing.orderedBreakdownLabels(breakdown);
  const allocated = __testing.allocateApproxTokensByLabel(breakdown, labels, total);

  assert.equal(sum(allocated), total);
});
