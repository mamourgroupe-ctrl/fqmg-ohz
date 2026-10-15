import { z } from "zod";
import type { CostEstimate } from "@/agent/pricing";

/**
 * Budget gate for paid requests.
 *
 * Owner policy: USD 0.03 per task, USD 0.25 per day.
 *
 * What this ledger does:
 *  - reserves before the request and settles afterwards, so two concurrent requests in the same
 *    process cannot both consume the same remaining budget;
 *  - refuses a request whose cost cannot be determined (`pricing-unknown`);
 *  - requires an explicit, attributed approval before exceeding the per-task limit;
 *  - keeps the daily limit hard: an approval can raise a task limit, never the daily ceiling.
 *
 * What this ledger does NOT do (stated in docs/agent-loop.md and reported in every result):
 *  - it is process-local. There is no shared store, so a second server instance, a serverless
 *    fan-out, or a restart does not see these reservations;
 *  - it cannot guarantee the provider's final invoice. Provider-side retries, token accounting
 *    differences, and price changes are outside the application's control.
 */

export const BudgetApprovalSchema = z.object({
  kind: z.literal("user-approved-exception"),
  approvedBy: z.string().trim().min(2).max(120),
  maxUsd: z.number().finite().positive().max(100),
  reason: z.string().trim().min(4).max(400),
});

export type BudgetApproval = z.infer<typeof BudgetApprovalSchema>;

export interface BudgetPolicy {
  dailyLimitUsd: number;
  taskLimitUsd: number;
}

export type BudgetRefusalCode =
  | "pricing-unknown"
  | "invalid-estimate"
  | "task-limit-exceeded"
  | "daily-limit-exceeded"
  | "duplicate-reservation"
  | "unknown-reservation";

export type ReserveOutcome =
  | {
      ok: true;
      reservationId: string;
      estimatedUsd: number;
      approvalUsed: boolean;
      remainingDailyUsd: number;
    }
  | { ok: false; code: BudgetRefusalCode; message: string };

export interface BudgetSnapshot {
  dayUtc: string;
  dailyReservedUsd: number;
  dailySettledUsd: number;
  dailyCommittedUsd: number;
  dailyLimitUsd: number;
  taskLimitUsd: number;
  activeReservations: number;
  taskIds: string[];
  /** Always "process-local": see the module header. */
  enforcement: "process-local";
  /** Explicit reminder that a local ledger is not an invoice guarantee. */
  invoiceGuarantee: false;
}

interface Reservation {
  reservationId: string;
  taskId: string;
  estimatedUsd: number;
  createdAt: number;
  approvalUsed: boolean;
}

function utcDayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export class BudgetLedger {
  private readonly policy: BudgetPolicy;
  private readonly now: () => number;
  private readonly reservations = new Map<string, Reservation>();
  private settledToday = 0;
  private dayUtc: string;
  private sequence = 0;

  constructor(options: { policy: BudgetPolicy; now?: () => number }) {
    this.policy = options.policy;
    this.now = options.now ?? Date.now;
    this.dayUtc = utcDayKey(this.now());
  }

  private rollDay(): void {
    const today = utcDayKey(this.now());
    if (today === this.dayUtc) return;
    this.dayUtc = today;
    this.settledToday = 0;
    this.reservations.clear();
  }

  get dailyLimitUsd(): number {
    return this.policy.dailyLimitUsd;
  }

  get taskLimitUsd(): number {
    return this.policy.taskLimitUsd;
  }

  /** Reserved but not yet settled, plus settled spend for the current UTC day. */
  private committed(): number {
    this.rollDay();
    let reserved = 0;
    for (const reservation of this.reservations.values()) reserved += reservation.estimatedUsd;
    return round(reserved + this.settledToday);
  }

  /**
   * Reserves budget for one task. Synchronous by design: the check and the write cannot be
   * interleaved by another request in the same process.
   */
  reserve(input: {
    taskId: string;
    estimate: CostEstimate | undefined;
    approval?: BudgetApproval;
  }): ReserveOutcome {
    this.rollDay();

    if (!input.estimate) {
      return {
        ok: false,
        code: "pricing-unknown",
        message:
          "The cost of this paid request cannot be determined reliably, so it was refused. Provide verified provider pricing (AGENT_PRICE_* variables) or run without the paid provider.",
      };
    }
    const estimateUsd = input.estimate.usd;
    if (!Number.isFinite(estimateUsd) || estimateUsd < 0) {
      return {
        ok: false,
        code: "invalid-estimate",
        message: "The cost estimate is not a finite non-negative amount.",
      };
    }

    for (const reservation of this.reservations.values()) {
      if (reservation.taskId === input.taskId) {
        return {
          ok: false,
          code: "duplicate-reservation",
          message:
            "This task already holds an active budget reservation. Wait for it to finish instead of starting a duplicate paid request.",
        };
      }
    }

    const approval = input.approval ? BudgetApprovalSchema.safeParse(input.approval) : undefined;
    if (input.approval && !approval?.success) {
      return {
        ok: false,
        code: "invalid-estimate",
        message: "The supplied budget exception approval is not valid.",
      };
    }

    const committed = this.committed();
    const remainingDaily = round(this.policy.dailyLimitUsd - committed);
    const approvalUsed = approval?.success === true;

    if (estimateUsd > remainingDaily) {
      return {
        ok: false,
        code: "daily-limit-exceeded",
        message: `The request is estimated at USD ${estimateUsd.toFixed(4)} but only USD ${Math.max(0, remainingDaily).toFixed(4)} of the USD ${this.policy.dailyLimitUsd.toFixed(2)} daily budget remains. An approval cannot raise the daily ceiling.`,
      };
    }

    if (estimateUsd > this.policy.taskLimitUsd) {
      if (!approval || !approval.success) {
        return {
          ok: false,
          code: "task-limit-exceeded",
          message: `The request is estimated at USD ${estimateUsd.toFixed(4)}, above the USD ${this.policy.taskLimitUsd.toFixed(2)} per-task limit. Retry with an explicit user-approved exception.`,
        };
      }
      if (approval.data.maxUsd < estimateUsd) {
        return {
          ok: false,
          code: "task-limit-exceeded",
          message: `The approval covers USD ${approval.data.maxUsd.toFixed(4)} but the request is estimated at USD ${estimateUsd.toFixed(4)}.`,
        };
      }
    }

    this.sequence += 1;
    const reservationId = `reservation-${this.sequence}`;
    this.reservations.set(reservationId, {
      reservationId,
      taskId: input.taskId,
      estimatedUsd: round(estimateUsd),
      createdAt: this.now(),
      approvalUsed,
    });

    return {
      ok: true,
      reservationId,
      estimatedUsd: round(estimateUsd),
      approvalUsed,
      remainingDailyUsd: round(this.policy.dailyLimitUsd - this.committed()),
    };
  }

  /** Settles a reservation with the locally known cost (defaults to the estimate). */
  settle(reservationId: string, actualUsd?: number): ReserveOutcome {
    this.rollDay();
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      return {
        ok: false,
        code: "unknown-reservation",
        message: "The reservation is unknown (already settled, released, or from another process).",
      };
    }

    const actual = actualUsd ?? reservation.estimatedUsd;
    if (!Number.isFinite(actual) || actual < 0) {
      return {
        ok: false,
        code: "invalid-estimate",
        message: "The settled amount is not a finite non-negative number.",
      };
    }

    this.reservations.delete(reservationId);
    this.settledToday = round(this.settledToday + actual);
    return {
      ok: true,
      reservationId,
      estimatedUsd: round(actual),
      approvalUsed: reservation.approvalUsed,
      remainingDailyUsd: round(this.policy.dailyLimitUsd - this.committed()),
    };
  }

  /** Releases a reservation without spending it (for example when a provider never ran). */
  release(reservationId: string): ReserveOutcome {
    this.rollDay();
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      return {
        ok: false,
        code: "unknown-reservation",
        message: "The reservation is unknown (already settled, released, or from another process).",
      };
    }
    this.reservations.delete(reservationId);
    return {
      ok: true,
      reservationId,
      estimatedUsd: reservation.estimatedUsd,
      approvalUsed: reservation.approvalUsed,
      remainingDailyUsd: round(this.policy.dailyLimitUsd - this.committed()),
    };
  }

  snapshot(): BudgetSnapshot {
    this.rollDay();
    let reserved = 0;
    const taskIds: string[] = [];
    for (const reservation of this.reservations.values()) {
      reserved += reservation.estimatedUsd;
      taskIds.push(reservation.taskId);
    }
    return {
      dayUtc: this.dayUtc,
      dailyReservedUsd: round(reserved),
      dailySettledUsd: round(this.settledToday),
      dailyCommittedUsd: round(reserved + this.settledToday),
      dailyLimitUsd: this.policy.dailyLimitUsd,
      taskLimitUsd: this.policy.taskLimitUsd,
      activeReservations: this.reservations.size,
      taskIds,
      enforcement: "process-local",
      invoiceGuarantee: false,
    };
  }
}
