import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Phase 5 — shared state and persistence (prompts/phase-5).
 *
 * The acceptance criterion is exercised against a REAL Redis server: budget
 * ledgers and job registries from two independent "instances" (separate
 * clients, separate in-process stores) share one Redis database. Locally the
 * server is a source-built redis binary (see the phase report); in CI it is
 * the redis service container.
 *
 * FQMG_TEST_REDIS_URL selects the server (default redis://127.0.0.1:6399).
 * Suites are skipped when it is unreachable UNLESS FQMG_REQUIRE_REDIS_TESTS=1
 * (set by CI) — in that case an unreachable server FAILS the suite instead of
 * silently skipping it, so a CI misconfiguration can never fake a green run.
 */

const REDIS_URL = process.env.FQMG_TEST_REDIS_URL?.trim() || "redis://127.0.0.1:6399";
const REQUIRE_REDIS = process.env.FQMG_REQUIRE_REDIS_TESTS === "1";

let redisAvailable = false;
let redisProbeError = "";

beforeAll(async () => {
  try {
    const { createClient } = await import("redis");
    const probe = createClient({
      socket: {
        connectTimeout: 2_000,
        // A dead port must REJECT, not retry forever: node-redis's default
        // reconnectStrategy keeps retrying and connect() then hangs past
        // connectTimeout, which turned the intended skip into a hook timeout
        // (observed on a restored sandbox where the port is silently
        // dropped instead of refused). REQUIRE mode still fails the suite.
        reconnectStrategy: false,
      },
      url: REDIS_URL,
    });
    probe.on("error", () => undefined);
    // Hard cap on top of connectTimeout: skip decisions must never hang.
    await Promise.race([
      (async () => {
        await probe.connect();
        await probe.ping();
        await probe.quit();
      })(),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("redis probe timed out")), 4_000);
        timer.unref?.();
      }),
    ]);
    redisAvailable = true;
  } catch (error) {
    redisProbeError = error instanceof Error ? error.message : String(error);
  }
});

afterAll(async () => {
  // nothing persistent: every suite uses its own namespace
});

const estimate = (usd: number) =>
  ({
    usd,
    basis: "unit-test",
    pricing: {
      providerId: "test-provider",
      modelId: "test-model",
      unit: "per-million-tokens" as const,
      inputUsdPerMillionTokens: 0.15,
      outputUsdPerMillionTokens: 0.6,
      sourceUrl: "https://example.test/pricing",
      verifiedOn: "2026-01-01",
    },
    usage: { inputTokens: 1_000, outputTokens: 1_000 },
  });

async function withRedis(run: () => Promise<void>): Promise<void> {
  if (redisAvailable) {
    await run();
    return;
  }
  if (REQUIRE_REDIS) {
    throw new Error(
      `FQMG_REQUIRE_REDIS_TESTS=1 but Redis is unreachable at ${REDIS_URL}: ${redisProbeError}`,
    );
  }
  console.warn(`[shared-state] skipping Redis suites — no server at ${REDIS_URL}`);
}

/** Minimal AgentLoopResult stub matching the persistable shape. */
async function loopResultStub(
  status: "passed" | "needs_review" | "failed" | "cancelled" = "passed",
): Promise<import("@/agent/loop").AgentLoopResult> {
  return {
    status,
    stage: "completed" as const,
    approved: status === "passed",
    failureReason: status === "cancelled" ? ("cancelled" as const) : null,
    iterations: 1,
    engine: "remotion-local",
    artifact: null,
    previewArtifact: null,
    validation: null,
    critiqueSummary: null,
    errorMessage: null,
    estimatedCostUsd: null,
    budget: {
      dailyCommittedUsd: 0,
      dailyLimitUsd: 0.25,
      taskLimitUsd: 0.03,
      activeReservations: 0,
      enforcement: "process-local" as const,
      invoiceGuarantee: false as const,
    },
    iterationsLog: [],
    disclosures: [],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  } as unknown as import("@/agent/loop").AgentLoopResult;
}

const budgetView = {
  dailyCommittedUsd: 0,
  dailyLimitUsd: 0.25,
  taskLimitUsd: 0.03,
  activeReservations: 0,
  enforcement: "process-local" as const,
  invoiceGuarantee: false as const,
};

describe("phase 5: shared budget across two instances (real Redis)", () => {
  it(
    "survives a restart: a fresh instance sees and settles the previous instance's reservation",
    { skip: !redisAvailable && !REQUIRE_REDIS },
    async () => {
      await withRedis(async () => {
        const { createBudgetLedger } = await import("@/agent/budget");
        const namespace = `t:${randomUUID()}`;

        const first = createBudgetLedger({
          policy: { dailyLimitUsd: 0.05, taskLimitUsd: 0.03 },
          redisUrl: REDIS_URL,
          namespace,
        });
        expect(first.enforcement).toBe("shared-redis");

        const reserved = await first.reserve({ taskId: "task-1", estimate: estimate(0.02) });
        expect(reserved.ok).toBe(true);
        await first.close();

        // "restart": a brand-new ledger with its own client, same namespace
        const second = createBudgetLedger({ policy: { dailyLimitUsd: 0.05, taskLimitUsd: 0.03 }, redisUrl: REDIS_URL, namespace });
        const snapshot = await second.snapshot();
        expect(snapshot.enforcement).toBe("shared-redis");
        expect(snapshot.dailyReservedUsd).toBe(0.02);
        expect(snapshot.activeReservations).toBe(1);
        expect(snapshot.taskIds).toEqual(["task-1"]);

        // the shared budget is binding: 0.04 more does not fit in the 0.05 ceiling
        const refused = await second.reserve({ taskId: "task-2", estimate: estimate(0.04) });
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.code).toBe("daily-limit-exceeded");

        // settling through the NEW instance frees the reservation
        const settled = await second.settle((reserved as { reservationId: string }).reservationId, 0.02);
        expect(settled.ok).toBe(true);
        const after = await second.snapshot();
        expect(after.dailySettledUsd).toBe(0.02);
        expect(after.activeReservations).toBe(0);
        await second.close();
      });
    },
  );

  it(
    "is atomic under concurrency: two instances reserving at once cannot both exceed the ceiling",
    { skip: !redisAvailable && !REQUIRE_REDIS },
    async () => {
      await withRedis(async () => {
        const { createBudgetLedger } = await import("@/agent/budget");

        const racePolicy = { dailyLimitUsd: 0.05, taskLimitUsd: 0.05 };
        for (let round = 0; round < 3; round += 1) {
          const namespace = `t:${randomUUID()}`;
          const a = createBudgetLedger({ policy: racePolicy, redisUrl: REDIS_URL, namespace });
          const b = createBudgetLedger({ policy: racePolicy, redisUrl: REDIS_URL, namespace });

          const [ra, rb] = await Promise.all([
            a.reserve({ taskId: `concurrent-a-${round}`, estimate: estimate(0.04) }),
            b.reserve({ taskId: `concurrent-b-${round}`, estimate: estimate(0.04) }),
          ]);

          const okCount = [ra.ok, rb.ok].filter(Boolean).length;
          expect(okCount, "exactly one of two racing reservations may pass").toBe(1);

          const snapshot = await a.snapshot();
          expect(snapshot.dailyReservedUsd).toBeLessThanOrEqual(0.05);
          await a.close();
          await b.close();
        }
      });
    },
  );

  it(
    "keeps the phase-3 per-user ceiling across instances",
    { skip: !redisAvailable && !REQUIRE_REDIS },
    async () => {
      await withRedis(async () => {
        const { createBudgetLedger } = await import("@/agent/budget");
        const namespace = `t:${randomUUID()}`;
        const policy = {
          dailyLimitUsd: 1,
          taskLimitUsd: 0.03,
          userDailyLimitUsd: 0.05,
        };
        const alice = createBudgetLedger({ policy, redisUrl: REDIS_URL, namespace });
        const bob = createBudgetLedger({ policy, redisUrl: REDIS_URL, namespace });

        const a1 = await alice.reserve({ taskId: "a-1", estimate: estimate(0.02), user: "alice" });
        expect(a1.ok).toBe(true);
        const a2 = await alice.reserve({ taskId: "a-2", estimate: estimate(0.02), user: "alice" });
        expect(a2.ok).toBe(true);
        // alice is at 0.04 of 0.05: one more 0.02 must refuse HER without touching bob
        const a3 = await alice.reserve({ taskId: "a-3", estimate: estimate(0.02), user: "alice" });
        expect(a3.ok).toBe(false);
        const b1 = await bob.reserve({ taskId: "b-1", estimate: estimate(0.02), user: "bob" });
        expect(b1.ok).toBe(true);
        await alice.close();
        await bob.close();
      });
    },
  );

  it(
    "fails closed when the shared store is unreachable (no silent local fallback)",
    { skip: !redisAvailable && !REQUIRE_REDIS },
    async () => {
      await withRedis(async () => {
        const { createBudgetLedger } = await import("@/agent/budget");
        // port with no listener in the sandbox
        const ledger = createBudgetLedger({
          policy: { dailyLimitUsd: 1, taskLimitUsd: 0.03 },
          redisUrl: "redis://127.0.0.1:6390",
          namespace: `t:${randomUUID()}`,
          connectTimeoutMs: 400,
        });
        const refused = await ledger.reserve({ taskId: "t", estimate: estimate(0.01) });
        expect(refused.ok).toBe(false);
        if (!refused.ok) {
          expect(refused.code).toBe("store-unavailable");
        }
        await ledger.close();
      });
    },
  );

  it(
    "without FQMG_REDIS_URL the ledger stays process-local (dev default)",
    async () => {
      const { BudgetLedger } = await import("@/agent/budget");
      const ledger = new BudgetLedger({
        policy: { dailyLimitUsd: 1, taskLimitUsd: 0.03 },
      });
      const snapshot = await ledger.snapshot();
      expect(snapshot.enforcement).toBe("process-local");
      // the local backend keeps the exact phase-3 semantics on the async surface
      const reserved = await ledger.reserve({ taskId: "t", estimate: estimate(0.01) });
      expect(reserved.ok).toBe(true);
    },
  );
});

describe("phase 5: shared job registry across two instances (real Redis)", () => {
  it(
    "a second instance polls a job started elsewhere and survives a restart",
    { skip: !redisAvailable && !REQUIRE_REDIS },
    async () => {
      await withRedis(async () => {
        const { AgentJobStore } = await import("@/agent/job-store");
        const { createRedisJobStateStore } = await import("@/agent/job-state-store");
        const namespace = `t:${randomUUID()}`;

        const stateA = createRedisJobStateStore({ redisUrl: REDIS_URL, namespace });
        const storeA = new AgentJobStore({ ttlMs: 60_000, stateStore: stateA });
        const job = await storeA.startJob({
          taskId: "task-x",
          dedupeKey: `dk-${randomUUID()}`,
          budgetSnapshot: () => budgetView,
          run: async () => loopResultStub("passed"),
        });

        // let the run finish and the mirror settle
        await new Promise((resolve) => setTimeout(resolve, 80));

        // a second instance, its own client and empty local map, sees the job
        const stateB = createRedisJobStateStore({ redisUrl: REDIS_URL, namespace });
        const storeB = new AgentJobStore({ ttlMs: 60_000, stateStore: stateB });
        const seen = await storeB.getJob(job.jobId);
        expect(seen).toBeDefined();
        expect(seen?.status).toBe("passed");
        expect(seen?.result?.status).toBe("passed");
        await stateB.close();

        // "restart" instance A: a fresh store with the same namespace still sees the record
        const stateA2 = createRedisJobStateStore({ redisUrl: REDIS_URL, namespace });
        const storeA2 = new AgentJobStore({ ttlMs: 60_000, stateStore: stateA2 });
        expect((await storeA2.getJob(job.jobId))?.status).toBe("passed");
        await stateA2.close();
        await stateA.close();
      });
    },
  );

  it(
    "refuses a duplicate active request across instances (shared dedupe)",
    { skip: !redisAvailable && !REQUIRE_REDIS },
    async () => {
      await withRedis(async () => {
        const { AgentJobStore, AgentJobConflictError } = await import("@/agent/job-store");
        const { createRedisJobStateStore } = await import("@/agent/job-state-store");
        const namespace = `t:${randomUUID()}`;
        const dedupeKey = `dk-${randomUUID()}`;

        const stateA = createRedisJobStateStore({ redisUrl: REDIS_URL, namespace });
        const storeA = new AgentJobStore({ ttlMs: 60_000, stateStore: stateA });
        let releaseRun: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
          releaseRun = resolve;
        });
        storeA.startJob({
          taskId: "task-y",
          dedupeKey,
          budgetSnapshot: () => budgetView,
          run: async () => {
            await gate;
            return loopResultStub("passed");
          },
        });

        const stateB = createRedisJobStateStore({ redisUrl: REDIS_URL, namespace });
        const storeB = new AgentJobStore({ ttlMs: 60_000, stateStore: stateB });
        // the mirror may take a moment; poll briefly
        let conflict: unknown;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          try {
            await storeB.startJob({
              taskId: "task-y",
              dedupeKey,
              budgetSnapshot: () => budgetView,
              run: async () => loopResultStub("failed"),
            });
            conflict = undefined;
          } catch (error) {
            conflict = error;
            break;
          }
        }
        expect(conflict).toBeInstanceOf(AgentJobConflictError);

        releaseRun?.();
        await stateA.close();
        await stateB.close();
      });
    },
  );

  it(
    "cancels across instances: instance B cancels, instance A's run is aborted",
    { skip: !redisAvailable && !REQUIRE_REDIS },
    async () => {
      await withRedis(async () => {
        const { AgentJobStore } = await import("@/agent/job-store");
        const { createRedisJobStateStore } = await import("@/agent/job-state-store");
        const namespace = `t:${randomUUID()}`;
        const dedupeKey = `dk-${randomUUID()}`;

        const stateA = createRedisJobStateStore({ redisUrl: REDIS_URL, namespace });
        const storeA = new AgentJobStore({ ttlMs: 60_000, stateStore: stateA });
        const job = await storeA.startJob({
          taskId: "task-z",
          dedupeKey,
          budgetSnapshot: () => budgetView,
          // mirrors the real loop: an aborted run resolves with a cancelled result
          run: async (signal) => {
            if (signal.aborted) return loopResultStub("cancelled");
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            );
            return loopResultStub("cancelled");
          },
        });

        const stateB = createRedisJobStateStore({ redisUrl: REDIS_URL, namespace });
        const storeB = new AgentJobStore({ ttlMs: 60_000, stateStore: stateB });
        let cancelled = false;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          cancelled = await storeB.cancelJobAcrossInstances(job.jobId);
          if (cancelled) break;
        }
        expect(cancelled).toBe(true);

        // instance A's record reflects the cancellation within its poll interval
        let status: string | undefined;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          status = (await storeA.getJob(job.jobId))?.status;
          if (status === "cancelled") break;
        }
        expect(status).toBe("cancelled");
        await stateA.close();
        await stateB.close();
      });
    },
  );

  it(
    "widens the budget view schema to the shared enforcement mode",
    async () => {
      const { AgentJobBudgetViewSchema } = await import("@/agent/job-store");
      const parsed = AgentJobBudgetViewSchema.safeParse({
        dailyCommittedUsd: 0.01,
        dailyLimitUsd: 0.25,
        taskLimitUsd: 0.03,
        activeReservations: 1,
        enforcement: "shared-redis",
        invoiceGuarantee: false,
      });
      expect(parsed.success).toBe(true);
      const local = AgentJobBudgetViewSchema.safeParse({
        dailyCommittedUsd: 0,
        dailyLimitUsd: 0.25,
        taskLimitUsd: 0.03,
        activeReservations: 0,
        enforcement: "process-local",
        invoiceGuarantee: false,
      });
      expect(local.success).toBe(true);
    },
  );
});

describe("phase 5: agent runtime wiring", () => {
  it(
    "createAgentRuntime picks the shared backends when FQMG_REDIS_URL is set",
    { skip: !redisAvailable && !REQUIRE_REDIS },
    async () => {
      await withRedis(async () => {
        const { createAgentRuntime } = await import("@/agent/runtime");
        const runtime = createAgentRuntime({
          ...process.env,
          FQMG_REDIS_URL: REDIS_URL,
          FQMG_SHARED_NAMESPACE: `t:${randomUUID()}`,
        });
        expect(runtime.budget.enforcement).toBe("shared-redis");
        expect(runtime.store.sharedStateKind).toBe("shared-redis");
        const snapshot = await runtime.budget.snapshot();
        expect(snapshot.enforcement).toBe("shared-redis");
        await runtime.closeSharedStores?.();
      });
    },
  );
});

// keep zod import used even when every redis suite is skipped
void z;
