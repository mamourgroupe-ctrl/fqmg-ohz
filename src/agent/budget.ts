import { z } from "zod";
import type { CostEstimate } from "@/agent/pricing";
import {
  fromMicroUsd,
  LocalBudgetBackend,
  newReservationId,
  RedisBudgetBackend,
  toMicroUsd,
  type BudgetBackend,
  type BudgetBackendKind,
} from "@/agent/budget-store";

/**
 * Budget gate for paid requests.
 *
 * Owner policy: USD 0.03 per task, USD 0.25 per day.
 *
 * What this ledger does:
 *  - reserves before the request and settles afterwards, so concurrent requests cannot both
 *    consume the same remaining budget;
 *  - refuses a request whose cost cannot be determined (`pricing-unknown`);
 *  - requires an explicit, attributed approval before exceeding the per-task limit;
 *  - keeps the daily limit hard: an approval can raise a task limit, never the daily ceiling;
 *  - (phase 5) enforces the ceilings through a swappable backend: the process-local ledger
 *    (single instance, dev default) or a Redis backend whose reserve/settle/release run as
 *    atomic Lua scripts shared by every server instance. With a shared backend configured and
 *    unreachable, reserve FAILS CLOSED with `store-unavailable` — never a silent local fallback.
 *
 * What this ledger does NOT do (stated in docs/agent-loop.md and reported in every result):
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
  /**
   * Optional per-user daily ceiling (phase 3). When unset, every user is bounded
   * by the global daily ceiling alone. An approval can raise a task limit but
   * never the daily or per-user daily ceiling.
   */
  userDailyLimitUsd?: number;
}

export type BudgetRefusalCode =
  | "pricing-unknown"
  | "invalid-estimate"
  | "task-limit-exceeded"
  | "daily-limit-exceeded"
  | "duplicate-reservation"
  | "unknown-reservation"
  | "store-unavailable";

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
  /** "process-local" (single instance) or "shared-redis" (phase 5). */
  enforcement: BudgetBackendKind;
  /** Explicit reminder that neither backend is an invoice guarantee. */
  invoiceGuarantee: false;
}

function utcDayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export class BudgetLedger {
  private readonly policy: BudgetPolicy;
  private readonly now: () => number;
  private readonly backend: BudgetBackend;

  constructor(options: {
    policy: BudgetPolicy;
    now?: () => number;
    /** Explicit backend override (tests). */
    backend?: BudgetBackend;
    /** Phase 5: when set (and no explicit backend), the atomic Redis backend is used. */
    redisUrl?: string;
    namespace?: string;
    connectTimeoutMs?: number;
  }) {
    this.policy = options.policy;
    this.now = options.now ?? Date.now;
    if (options.backend) {
      this.backend = options.backend;
    } else if (options.redisUrl) {
      this.backend = new RedisBudgetBackend({
        redisUrl: options.redisUrl,
        namespace: options.namespace ?? "default",
        connectTimeoutMs: options.connectTimeoutMs,
      });
    } else {
      this.backend = new LocalBudgetBackend({ now: options.now });
    }
  }

  get dailyLimitUsd(): number {
    return this.policy.dailyLimitUsd;
  }

  get taskLimitUsd(): number {
    return this.policy.taskLimitUsd;
  }

  get enforcement(): BudgetBackendKind {
    return this.backend.kind;
  }

  async reserve(input: {
    taskId: string;
    estimate: CostEstimate | undefined;
    approval?: BudgetApproval;
    user?: string;
  }): Promise<ReserveOutcome> {
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

    const approval = input.approval ? BudgetApprovalSchema.safeParse(input.approval) : undefined;
    if (input.approval && !approval?.success) {
      return {
        ok: false,
        code: "invalid-estimate",
        message: "The supplied budget exception approval is not valid.",
      };
    }

    const nowMs = this.now();
    const result = await this.backend.reserve({
      dayUtc: utcDayKey(nowMs),
      reservationId: newReservationId(),
      taskId: input.taskId,
      estimateMicros: toMicroUsd(estimateUsd),
      ...(input.user ? { user: input.user } : {}),
      approvalUsed: approval?.success === true,
      approvalMaxMicros: approval?.success === true ? toMicroUsd(approval.data.maxUsd) : -1,
      dailyLimitMicros: toMicroUsd(this.policy.dailyLimitUsd),
      taskLimitMicros: toMicroUsd(this.policy.taskLimitUsd),
      userDailyLimitMicros:
        this.policy.userDailyLimitUsd !== undefined ? toMicroUsd(this.policy.userDailyLimitUsd) : -1,
      nowMs,
    });

    if (result.ok) {
      return {
        ok: true,
        reservationId: result.reservationId,
        estimatedUsd: fromMicroUsd(result.estimateMicros),
        approvalUsed: result.approvalUsed,
        remainingDailyUsd: fromMicroUsd(result.remainingDailyMicros),
      };
    }

    switch (result.code) {
      case "duplicate-reservation":
        return {
          ok: false,
          code: "duplicate-reservation",
          message:
            "This task already holds an active budget reservation. Wait for it to finish instead of starting a duplicate paid request.",
        };
      case "daily-limit-exceeded": {
        const remainingDailyUsd = fromMicroUsd(result.remainingDailyMicros ?? 0);
        const effectiveRemainingUsd = fromMicroUsd(result.effectiveRemainingMicros ?? 0);
        return {
          ok: false,
          code: "daily-limit-exceeded",
          message:
            result.userCeilingBinding && input.user
              ? `The user ${input.user} has USD ${Math.max(0, effectiveRemainingUsd).toFixed(4)} left of their USD ${(this.policy.userDailyLimitUsd ?? this.policy.dailyLimitUsd).toFixed(2)} daily budget, but the request is estimated at USD ${estimateUsd.toFixed(4)}.`
              : `The request is estimated at USD ${estimateUsd.toFixed(4)} but only USD ${Math.max(0, remainingDailyUsd).toFixed(4)} of the USD ${this.policy.dailyLimitUsd.toFixed(2)} daily budget remains. An approval cannot raise the daily ceiling.`,
        };
      }
      case "task-limit-exceeded": {
        if (approval?.success) {
          return {
            ok: false,
            code: "task-limit-exceeded",
            message: `The approval covers USD ${approval.data.maxUsd.toFixed(4)} but the request is estimated at USD ${estimateUsd.toFixed(4)}.`,
          };
        }
        return {
          ok: false,
          code: "task-limit-exceeded",
          message: `The request is estimated at USD ${estimateUsd.toFixed(4)}, above the USD ${this.policy.taskLimitUsd.toFixed(2)} per-task limit. Retry with an explicit user-approved exception.`,
        };
      }
      case "store-unavailable":
        return {
          ok: false,
          code: "store-unavailable",
          message:
            "The shared budget store is unreachable, so this paid request was refused (fail-closed). Retry once the store is back; the request was never started.",
        };
    }
  }

  /** Settles a reservation with the locally known cost (defaults to the estimate). */
  async settle(reservationId: string, actualUsd?: number): Promise<ReserveOutcome> {
    const estimate = await this.reservedEstimateOf(reservationId);
    const actual = actualUsd ?? estimate;
    if (!Number.isFinite(actual) || actual < 0) {
      return {
        ok: false,
        code: "invalid-estimate",
        message: "The settled amount is not a finite non-negative number.",
      };
    }
    const result = await this.backend.settle(
      reservationId,
      toMicroUsd(actual),
      toMicroUsd(this.policy.dailyLimitUsd),
    );
    if (!result.ok) {
      if (result.code === "store-unavailable") {
        return {
          ok: false,
          code: "store-unavailable",
          message: "The shared budget store is unreachable; the reservation was NOT settled and will expire.",
        };
      }
      return {
        ok: false,
        code: "unknown-reservation",
        message: "The reservation is unknown (already settled, released, or from another process).",
      };
    }
    return {
      ok: true,
      reservationId: result.reservationId,
      estimatedUsd: fromMicroUsd(result.estimateMicros),
      approvalUsed: result.approvalUsed,
      remainingDailyUsd: fromMicroUsd(result.remainingDailyMicros),
    };
  }

  /** Releases a reservation without spending it (for example when a provider never ran). */
  async release(reservationId: string): Promise<ReserveOutcome> {
    const result = await this.backend.release(
      reservationId,
      toMicroUsd(this.policy.dailyLimitUsd),
    );
    if (!result.ok) {
      if (result.code === "store-unavailable") {
        return {
          ok: false,
          code: "store-unavailable",
          message: "The shared budget store is unreachable; the reservation was NOT released and will expire.",
        };
      }
      return {
        ok: false,
        code: "unknown-reservation",
        message: "The reservation is unknown (already settled, released, or from another process).",
      };
    }
    return {
      ok: true,
      reservationId: result.reservationId,
      estimatedUsd: fromMicroUsd(result.estimateMicros),
      approvalUsed: result.approvalUsed,
      remainingDailyUsd: fromMicroUsd(result.remainingDailyMicros),
    };
  }

  async snapshot(): Promise<BudgetSnapshot> {
    const dayUtc = utcDayKey(this.now());
    const data = await this.backend.snapshot(dayUtc);
    if (data === "store-unavailable") {
      // A snapshot is reporting, not enforcement: report the failure instead of inventing numbers.
      return {
        dayUtc,
        dailyReservedUsd: 0,
        dailySettledUsd: 0,
        dailyCommittedUsd: 0,
        dailyLimitUsd: this.policy.dailyLimitUsd,
        taskLimitUsd: this.policy.taskLimitUsd,
        activeReservations: 0,
        taskIds: [],
        enforcement: this.backend.kind,
        invoiceGuarantee: false,
      };
    }
    return {
      dayUtc: data.dayUtc,
      dailyReservedUsd: fromMicroUsd(data.reservedMicros),
      dailySettledUsd: fromMicroUsd(data.settledMicros),
      dailyCommittedUsd: fromMicroUsd(data.reservedMicros + data.settledMicros),
      dailyLimitUsd: this.policy.dailyLimitUsd,
      taskLimitUsd: this.policy.taskLimitUsd,
      activeReservations: data.activeCount,
      taskIds: data.taskIds,
      enforcement: this.backend.kind,
      invoiceGuarantee: false,
    };
  }

  /** The reservation's recorded estimate, so settle() can default to it. */
  private async reservedEstimateOf(reservationId: string): Promise<number> {
    const record = await this.backend.getReservation(reservationId);
    if (record === "store-unavailable" || record === undefined) return 0;
    return fromMicroUsd(record.estimateMicros);
  }

  async close(): Promise<void> {
    await this.backend.close();
  }
}

/** Phase 5 convenience: a ledger bound to the shared Redis backend. */
export function createBudgetLedger(options: {
  policy: BudgetPolicy;
  redisUrl: string;
  namespace?: string;
  connectTimeoutMs?: number;
  now?: () => number;
}): BudgetLedger {
  return new BudgetLedger(options);
}
