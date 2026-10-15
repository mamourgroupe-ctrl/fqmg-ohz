import { describe, expect, it } from "vitest";
import { BudgetLedger, BudgetApprovalSchema } from "@/agent/budget";
import {
  buildUsageEstimate,
  EMPTY_PRICE_BOOK,
  estimateCost,
  estimateImageTokens,
  findPricing,
  loadPriceBook,
  type CostEstimate,
  type PriceBook,
  type TokenPricing,
} from "@/agent/pricing";

const VERIFIED_PRICING: TokenPricing = {
  providerId: "openai-compatible",
  modelId: "vision-small",
  unit: "per-million-tokens",
  inputUsdPerMillionTokens: 0.15,
  outputUsdPerMillionTokens: 0.6,
  sourceUrl: "https://example.invalid/pricing",
  verifiedOn: "2026-10-15",
};

function priceBookWith(pricing: TokenPricing): PriceBook {
  return { entries: [pricing] };
}

function estimate(usd: number): CostEstimate {
  return {
    usd,
    basis: "test estimate",
    pricing: VERIFIED_PRICING,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function ledger(
  options: { daily?: number; task?: number; now?: () => number } = {},
): BudgetLedger {
  return new BudgetLedger({
    policy: { dailyLimitUsd: options.daily ?? 0.25, taskLimitUsd: options.task ?? 0.03 },
    ...(options.now ? { now: options.now } : {}),
  });
}

describe("pricing", () => {
  it("ships an empty price book so unknown pricing cannot be mistaken for a known price", () => {
    expect(EMPTY_PRICE_BOOK.entries).toHaveLength(0);
    expect(
      estimateCost({
        priceBook: EMPTY_PRICE_BOOK,
        providerId: "openai-compatible",
        modelId: "vision-small",
        usage: { inputTokens: 1_000, outputTokens: 500 },
      }),
    ).toBeUndefined();
  });

  it("requires a complete, sourced, dated price entry from the environment", () => {
    const incomplete = loadPriceBook({
      AGENT_VISION_PROVIDER: "openai-compatible",
      AGENT_VISION_MODEL: "vision-small",
      AGENT_PRICE_INPUT_PER_MTOK: "0.15",
    });
    expect(incomplete.entries).toHaveLength(0);

    const complete = loadPriceBook({
      AGENT_VISION_PROVIDER: "openai-compatible",
      AGENT_VISION_MODEL: "vision-small",
      AGENT_PRICE_INPUT_PER_MTOK: "0.15",
      AGENT_PRICE_OUTPUT_PER_MTOK: "0.6",
      AGENT_PRICE_SOURCE_URL: "https://example.invalid/pricing",
      AGENT_PRICE_VERIFIED_ON: "2026-10-15",
    });
    expect(complete.entries).toHaveLength(1);
    expect(findPricing(complete, "openai-compatible", "vision-small")?.verifiedOn).toBe("2026-10-15");
  });

  it("estimates tokens conservatively and computes a rounded-up cost", () => {
    expect(estimateImageTokens(512, 512)).toBe(525);
    expect(estimateImageTokens(0, 10)).toBe(0);

    const usage = buildUsageEstimate({
      imagePixels: [{ width: 512, height: 512 }],
      promptText: "x".repeat(400),
      maxOutputTokens: 600,
    });
    expect(usage).toEqual({ inputTokens: 525 + 100, outputTokens: 600 });

    const cost = estimateCost({
      priceBook: priceBookWith(VERIFIED_PRICING),
      providerId: "openai-compatible",
      modelId: "vision-small",
      usage,
    });
    expect(cost?.usd).toBeCloseTo(0.000454, 6);
    expect(cost!.usd).toBeGreaterThanOrEqual(0.000454);
  });
});

describe("BudgetLedger", () => {
  it("refuses a request whose cost cannot be determined reliably", () => {
    const outcome = ledger().reserve({ taskId: "task-1", estimate: undefined });
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ code: "pricing-unknown" });
    if (!outcome.ok) expect(outcome.message).toMatch(/cannot be determined/i);
  });

  it("reserves, settles, and tracks the remaining daily budget", () => {
    const budget = ledger();
    const reservation = budget.reserve({ taskId: "task-1", estimate: estimate(0.01) });
    expect(reservation.ok).toBe(true);
    expect(budget.snapshot()).toMatchObject({
      dailyReservedUsd: 0.01,
      dailySettledUsd: 0,
      activeReservations: 1,
      enforcement: "process-local",
      invoiceGuarantee: false,
    });

    if (reservation.ok) {
      const settled = budget.settle(reservation.reservationId, 0.012);
      expect(settled.ok).toBe(true);
    }
    expect(budget.snapshot()).toMatchObject({
      dailyReservedUsd: 0,
      dailySettledUsd: 0.012,
      activeReservations: 0,
    });
  });

  it("rejects a duplicate reservation for a task that is still active", () => {
    const budget = ledger();
    expect(budget.reserve({ taskId: "task-1", estimate: estimate(0.01) }).ok).toBe(true);
    const duplicate = budget.reserve({ taskId: "task-1", estimate: estimate(0.01) });
    expect(duplicate).toMatchObject({ ok: false, code: "duplicate-reservation" });
  });

  it("bounds one task by the per-task limit and concurrent tasks by the daily limit", () => {
    const budget = ledger({ daily: 0.05, task: 0.03 });

    // A single task above the per-task limit is refused and asks for an explicit approval.
    const overTaskLimit = budget.reserve({ taskId: "task-1", estimate: estimate(0.04) });
    expect(overTaskLimit).toMatchObject({ ok: false, code: "task-limit-exceeded" });
    if (!overTaskLimit.ok) expect(overTaskLimit.message).toMatch(/user-approved exception/i);

    // Two tasks within the per-task limit still consume the shared daily budget.
    expect(budget.reserve({ taskId: "task-1", estimate: estimate(0.02) }).ok).toBe(true);
    expect(budget.reserve({ taskId: "task-2", estimate: estimate(0.02) }).ok).toBe(true);
    const third = budget.reserve({ taskId: "task-3", estimate: estimate(0.02) });
    expect(third).toMatchObject({ ok: false, code: "daily-limit-exceeded" });
    if (!third.ok) expect(third.message).toMatch(/daily budget/i);
  });

  it("requires an explicit, attributed approval to exceed the per-task limit", () => {
    const budget = ledger({ task: 0.03 });
    const badApproval = BudgetApprovalSchema.safeParse({
      kind: "user-approved-exception",
      approvedBy: "o",
      maxUsd: 0.04,
      reason: "too short",
    });
    expect(badApproval.success).toBe(false);

    const approved = budget.reserve({
      taskId: "task-1",
      estimate: estimate(0.04),
      approval: {
        kind: "user-approved-exception",
        approvedBy: "owner@example.com",
        maxUsd: 0.05,
        reason: "Manual one-off review of a long client video.",
      },
    });
    expect(approved).toMatchObject({ ok: true, approvalUsed: true });
  });

  it("refuses an approval that does not cover the estimate", () => {
    const outcome = ledger({ task: 0.03 }).reserve({
      taskId: "task-1",
      estimate: estimate(0.04),
      approval: {
        kind: "user-approved-exception",
        approvedBy: "owner@example.com",
        maxUsd: 0.035,
        reason: "Covers less than the estimate.",
      },
    });
    expect(outcome).toMatchObject({ ok: false, code: "task-limit-exceeded" });
  });

  it("never lets an approval raise the daily ceiling", () => {
    const budget = ledger({ daily: 0.05, task: 0.03 });
    expect(budget.reserve({ taskId: "task-1", estimate: estimate(0.03) }).ok).toBe(true);
    const overDaily = budget.reserve({
      taskId: "task-2",
      estimate: estimate(0.03),
      approval: {
        kind: "user-approved-exception",
        approvedBy: "owner@example.com",
        maxUsd: 0.5,
        reason: "Attempt to exceed the daily ceiling through an approval.",
      },
    });
    expect(overDaily).toMatchObject({ ok: false, code: "daily-limit-exceeded" });
  });

  it("releases budget and reports unknown reservations instead of guessing", () => {
    const budget = ledger();
    const reservation = budget.reserve({ taskId: "task-1", estimate: estimate(0.02) });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) return;
    expect(budget.release(reservation.reservationId).ok).toBe(true);
    expect(budget.snapshot().dailyReservedUsd).toBe(0);
    expect(budget.release(reservation.reservationId)).toMatchObject({
      ok: false,
      code: "unknown-reservation",
    });
    expect(budget.settle("reservation-does-not-exist")).toMatchObject({
      ok: false,
      code: "unknown-reservation",
    });
  });

  it("rejects a non-finite or negative estimate", () => {
    expect(
      ledger().reserve({ taskId: "task-1", estimate: { ...estimate(0.01), usd: Number.NaN } }),
    ).toMatchObject({ ok: false, code: "invalid-estimate" });
    expect(
      ledger().reserve({ taskId: "task-1", estimate: { ...estimate(0.01), usd: -1 } }),
    ).toMatchObject({ ok: false, code: "invalid-estimate" });
  });

  it("resets the day counter at the next UTC day", () => {
    let current = Date.parse("2026-10-15T23:00:00.000Z");
    const budget = ledger({ daily: 0.25, now: () => current });
    expect(budget.reserve({ taskId: "task-1", estimate: estimate(0.02) }).ok).toBe(true);
    current = Date.parse("2026-10-16T00:30:00.000Z");
    expect(budget.snapshot()).toMatchObject({
      dayUtc: "2026-10-16",
      dailyCommittedUsd: 0,
      activeReservations: 0,
    });
  });
});
