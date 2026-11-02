import type { UsageSnapshot } from "../src/types.ts";

export const NOW = 1_800_000_000_000;
export function sampleSnapshot(): UsageSnapshot {
  return {
    account: { provider: "openai-codex", accountId: "test-account", email: "tester@example.com" },
    plan: "plus",
    fetchedAt: NOW,
    limitReached: false,
    windows: [
      { id: "5h", label: "5h", usedPercent: 25, remainingPercent: 75, windowSeconds: 18_000, resetsAt: NOW + 2 * 3_600_000 },
      { id: "weekly", label: "Wk", usedPercent: 85, remainingPercent: 15, windowSeconds: 604_800, resetsAt: NOW + 4 * 86_400_000 },
    ],
  };
}
