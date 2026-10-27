import { describe, expect, it } from "vitest";
import { BudgetLedger } from "@/agent/budget";
import type { CostEstimate } from "@/agent/pricing";

/**
 * Phase 3 acceptance: the budget ceiling also exists per user, and exceeding
 * it fails closed without consuming another user's headroom. The global daily
 * ceiling stays hard for everyone.
 */

function estimateOf(usd: number): CostEstimate {
  return {
    usd,
    basis: "unit-test",
    pricing: {
      providerId: "test-provider",
      modelId: "test-model",
      unit: "per-million-tokens",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 2,
      sourceUrl: "https://example.test/price",
      verifiedOn: "2026-10-27",
    },
    usage: { inputTokens: 10_000, outputTokens: 10_000 },
  };
}

function ledgerWith(policy: {
  dailyLimitUsd: number;
  taskLimitUsd: number;
  userDailyLimitUsd?: number;
}): BudgetLedger {
  return new BudgetLedger({
    policy: {
      dailyLimitUsd: policy.dailyLimitUsd,
      taskLimitUsd: policy.taskLimitUsd,
      ...(policy.userDailyLimitUsd !== undefined ? { userDailyLimitUsd: policy.userDailyLimitUsd } : {}),
    },
  });
}

function settleOk(ledger: BudgetLedger, outcome: ReturnType<BudgetLedger["reserve"]>): void {
  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    const settled = ledger.settle(outcome.reservationId);
    expect(settled.ok).toBe(true);
  }
}

describe("phase 3: per-user budget ceilings", () => {
  it("refuses a user above their per-user daily ceiling while others keep their own headroom", () => {
    // three USD 0.02 requests exceed the USD 0.05 per-user day for one user only
    const ledger = ledgerWith({ dailyLimitUsd: 0.20, taskLimitUsd: 0.03, userDailyLimitUsd: 0.05 });

    settleOk(ledger, ledger.reserve({ taskId: "a:1", user: "alice", estimate: estimateOf(0.02) }));
    settleOk(ledger, ledger.reserve({ taskId: "a:2", user: "alice", estimate: estimateOf(0.02) }));

    const third = ledger.reserve({ taskId: "a:3", user: "alice", estimate: estimateOf(0.02) });
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.code).toBe("daily-limit-exceeded");
      expect(third.message).toContain("alice");
    }

    // bob still has his own full per-user headroom
    settleOk(ledger, ledger.reserve({ taskId: "b:1", user: "bob", estimate: estimateOf(0.02) }));
  });

  it("keeps the global daily ceiling hard across users", () => {
    const ledger = ledgerWith({ dailyLimitUsd: 0.05, taskLimitUsd: 0.03 });

    settleOk(ledger, ledger.reserve({ taskId: "a:1", user: "alice", estimate: estimateOf(0.02) }));
    settleOk(ledger, ledger.reserve({ taskId: "b:1", user: "bob", estimate: estimateOf(0.02) }));

    // global day is USD 0.05 committed: USD 0.04 spent, a USD 0.02 request no longer fits
    const anyone = ledger.reserve({ taskId: "c:1", user: "carol", estimate: estimateOf(0.02) });
    expect(anyone.ok).toBe(false);
    if (!anyone.ok) expect(anyone.code).toBe("daily-limit-exceeded");
  });

  it("defaults the per-user ceiling to the global daily ceiling when unset", () => {
    const ledger = ledgerWith({ dailyLimitUsd: 0.05, taskLimitUsd: 0.05 });

    settleOk(ledger, ledger.reserve({ taskId: "a:1", user: "alice", estimate: estimateOf(0.04) }));
    const second = ledger.reserve({ taskId: "a:2", user: "alice", estimate: estimateOf(0.04) });
    expect(second.ok).toBe(false);
  });
});
