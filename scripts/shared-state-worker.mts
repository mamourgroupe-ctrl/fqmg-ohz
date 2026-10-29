// Phase 5 verification worker — ONE side of a two-process shared-state check.
//
// Spawned by tests/two-process-shared-state.test.ts as a REAL separate Node
// process (child_process.spawn + tsx). It talks to the parent only through
// single-line JSON on stdout and to the other worker ONLY through the shared
// Redis store — exactly like two deployed server instances. Never used in
// production; lives in scripts/ next to the other operational helpers.
//
// Usage: tsx shared-state-worker.mts <role: a|b> <scenario: race|dedupe|cancel>
//        <redisUrl> <namespace> [dedupeKey] [jobId]
import { createBudgetLedger } from "../src/agent/budget";
import { AgentJobStore, AgentJobConflictError } from "../src/agent/job-store";
import { createRedisJobStateStore } from "../src/agent/job-state-store";
import type { AgentLoopResult } from "../src/agent/loop";

const argv = process.argv.slice(2);
const role = argv[0] as "a" | "b";
const scenario = argv[1] as "race" | "dedupe" | "cancel";
const redisUrl = argv[2]!;
const namespace = argv[3]!;
const dedupeKey = argv[4];
const jobIdArg = argv[5];

const send = (payload: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const POLICY = { dailyLimitUsd: 0.05, taskLimitUsd: 0.05 };

function resultStub(status: "passed" | "cancelled"): AgentLoopResult {
  return {
    status,
    stage: "completed",
    approved: status === "passed",
    iterations: 1,
    engine: "remotion-local",
    artifact: null,
    previewArtifact: null,
    validation: null,
    critiqueSummary: null,
    failureReason: status === "cancelled" ? "cancelled" : null,
    errorMessage: null,
    estimatedCostUsd: null,
    budget: {
      dailyCommittedUsd: 0,
      dailyLimitUsd: POLICY.dailyLimitUsd,
      taskLimitUsd: POLICY.taskLimitUsd,
      activeReservations: 0,
      enforcement: "shared-redis",
      invoiceGuarantee: false,
    },
    iterationsLog: [],
    disclosures: [],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  } as unknown as AgentLoopResult;
}

function estimate(usd: number) {
  return {
    usd,
    basis: "worker estimate",
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
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitUntilSettled(store: AgentJobStore, jobId: string): Promise<string | undefined> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const record = await store.getJob(jobId);
    const status = record?.status;
    if (status && status !== "queued" && status !== "running") return status;
    await sleep(100);
  }
  return undefined;
}

async function runScenario(): Promise<void> {
  if (scenario === "race") {
    const ledger = createBudgetLedger({ policy: POLICY, redisUrl, namespace });
    const outcome = await ledger.reserve({ taskId: `${role}-race`, estimate: estimate(0.04) });
    send(outcome.ok ? { role, ok: true } : { role, ok: false, code: outcome.code });
    await ledger.close();
    return;
  }

  const stateStore = createRedisJobStateStore({ redisUrl, namespace });
  const store = new AgentJobStore({ ttlMs: 60_000, stateStore });
  const budgetSnapshot = () => ({
    dailyCommittedUsd: 0,
    dailyLimitUsd: POLICY.dailyLimitUsd,
    taskLimitUsd: POLICY.taskLimitUsd,
    activeReservations: 0,
    enforcement: "shared-redis" as const,
    invoiceGuarantee: false as const,
  });

  if (role === "a") {
    const job = await store.startJob({
      taskId: `t-${scenario}`,
      dedupeKey: dedupeKey!,
      budgetSnapshot,
      run: async (signal) => {
        if (scenario === "cancel") {
          // The real loop resolves with a cancelled result when aborted.
          if (signal.aborted) return resultStub("cancelled");
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          return resultStub("cancelled");
        }
        // dedupe: a normally short run; an abort (if any) resolves cancelled.
        if (signal.aborted) return resultStub("cancelled");
        await sleep(2_500);
        return resultStub("passed");
      },
    });
    send({ role: "a", event: "started", jobId: job.jobId });
    const status = await waitUntilSettled(store, job.jobId);
    send({ role: "a", event: "final", status });
    await stateStore.close();
    return;
  }

  if (scenario === "dedupe") {
    let conflicted = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !conflicted) {
      try {
        await store.startJob({
          taskId: "t-dedupe-b",
          dedupeKey: dedupeKey!,
          budgetSnapshot,
          run: async () => resultStub("passed"),
        });
      } catch (error) {
        conflicted = error instanceof AgentJobConflictError;
        break;
      }
      await sleep(100);
    }
    send({ role: "b", conflicted });
    await stateStore.close();
    return;
  }

  // cancel: role b cancels the job A started (jobId forwarded by the parent).
  let cancelled = false;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !cancelled) {
    cancelled = await store.cancelJobAcrossInstances(jobIdArg!);
    if (!cancelled) await sleep(150);
  }
  send({ role: "b", cancelled });
  await stateStore.close();
}

runScenario().catch((error: unknown) => {
  send({ role, fatal: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
  process.exit(1);
});
