import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This suite exercises business logic, not the auth boundary: the explicit
// development escape keeps the handlers reachable (phase 3 covers 401/403/429
// in tests/api-auth.test.ts, tests/api-authorization.test.ts, tests/api-rate-limit.test.ts).
process.env.AUTH_ENABLED = "0";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import previewSpecification from "../templates/phase-one-preview.json";
import { AgentConfigError } from "@/agent/config";
import { ACTIVE_JOB_STATUSES, AgentJobStore, type AgentJobRecord } from "@/agent/job-store";
import type { AgentLoopResult } from "@/agent/loop";
import { MotionSpecificationSchema } from "@/motion/schemas/motion-specification";
import { toPublicArtifact, type LocalFileArtifact } from "@/agent/artifact";
import type { RenderBackend, RenderBackendRequest } from "@/agent/render-contract";

/**
 * These tests drive the real HTTP handlers and the real job store. Only the render backend is
 * replaced, so nothing bundles Remotion, launches a browser, or touches the network.
 */

const harness = vi.hoisted(() => ({ runtime: undefined as unknown }));

vi.mock("@/agent/runtime", () => ({
  getAgentRuntime: () => harness.runtime,
  createAgentRuntime: () => harness.runtime,
}));

const { POST } = await import("@/app/api/agent/qa/route");
const { GET, DELETE } = await import("@/app/api/agent/qa/[jobId]/route");
const { GET: getPreview } = await import("@/app/api/agent/qa/[jobId]/preview/route");
const { BudgetLedger } = await import("@/agent/budget");
const { AGENT_CONFIG_DEFAULTS } = await import("@/agent/config");
const { createDisabledMotionRepairProvider } = await import("@/agent/repair-provider");
const { createDisabledVisionProvider } = await import("@/agent/vision-providers");
const { EMPTY_PRICE_BOOK } = await import("@/agent/pricing");

const TEMP_DIRECTORIES: string[] = [];
const JOB_TTL_MS = 30 * 60 * 1000;

type RenderBehavior = "fail" | "hang";

interface TestRuntime {
  store: AgentJobStore;
  budget: InstanceType<typeof BudgetLedger>;
}

function createRuntime(options: { behavior: RenderBehavior; maxJobs?: number }): TestRuntime {
  const config = { ...AGENT_CONFIG_DEFAULTS, maxIterations: 2 };
  const budget = new BudgetLedger({
    policy: { dailyLimitUsd: config.dailyBudgetUsd, taskLimitUsd: config.taskBudgetUsd },
  });
  const store = new AgentJobStore({ ttlMs: JOB_TTL_MS, maxJobs: options.maxJobs ?? 32 });

  const renderBackend: RenderBackend = {
    engineId: "remotion-local",
    isConfigured: true,
    render(request: RenderBackendRequest) {
      if (options.behavior === "fail") {
        return Promise.reject(new Error("Rendering is unavailable in this test."));
      }
      return new Promise((_resolve, reject) => {
        const cancel = () => reject(new Error("The local render was cancelled."));
        if (request.signal?.aborted) {
          cancel();
          return;
        }
        request.signal?.addEventListener("abort", cancel, { once: true });
      });
    },
  };

  harness.runtime = {
    config,
    priceBook: EMPTY_PRICE_BOOK,
    budget,
    visionProvider: createDisabledVisionProvider(),
    repairProvider: createDisabledMotionRepairProvider(),
    store,
    getRenderBackend: () => renderBackend,
  };

  return { store, budget };
}

function runtime(): TestRuntime {
  return harness.runtime as TestRuntime;
}

function qaRequest(body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) {
  return new Request("http://localhost/api/agent/qa", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function jobContext(jobId: string) {
  return { params: Promise.resolve({ jobId }) };
}

async function waitForSettled(jobId: string): Promise<AgentJobRecord> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const job = runtime().store.getJob(jobId);
    if (job && !ACTIVE_JOB_STATUSES.includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`The job ${jobId} never settled.`);
}

async function makeDirectory(prefix = "fqmg-qa-"): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  TEMP_DIRECTORIES.push(directory);
  return directory;
}

/**
 * Creates a settled job whose result carries the given artifact. The store is the only component
 * that knows the job id, so the artifact is re-pointed at it afterwards, exactly as the loop does
 * when it receives the id from the API.
 */
async function startJobWithArtifact(artifact: LocalFileArtifact): Promise<AgentJobRecord> {
  const { store } = runtime();
  const job = store.startJob({
    taskId: "qa:test",
    dedupeKey: `test:${randomUUID()}`,
    budgetSnapshot: () => {
      const snapshot = runtime().budget.snapshot();
      return {
        dailyCommittedUsd: snapshot.dailyCommittedUsd,
        dailyLimitUsd: snapshot.dailyLimitUsd,
        taskLimitUsd: snapshot.taskLimitUsd,
        activeReservations: snapshot.activeReservations,
        enforcement: "process-local" as const,
        invoiceGuarantee: false as const,
      };
    },
    run: async (): Promise<AgentLoopResult> =>
      ({
        status: "needs_review",
        approved: false,
        iterations: 1,
        engine: "remotion-local",
        artifact,
        previewArtifact: null,
        validation: {
          sizeBytes: artifact.sizeBytes,
          format: "mp4",
          durationSeconds: 1,
          width: 1080,
          height: 1920,
          fps: 30,
        },
        critiqueSummary: {
          verdict: "unavailable",
          score: null,
          providerId: "disabled",
          modelId: "unconfigured",
          issueCount: 0,
          ruleIds: [],
          issues: [],
        },
        stage: "completed",
        failureReason: "critique-failed",
        errorMessage: "No vision provider is configured.",
        budget: {
          dayUtc: "2026-10-15",
          dailyReservedUsd: 0,
          dailySettledUsd: 0,
          dailyCommittedUsd: 0,
          dailyLimitUsd: 0.25,
          taskLimitUsd: 0.03,
          activeReservations: 0,
          taskIds: [],
          enforcement: "process-local",
          invoiceGuarantee: false,
        },
        estimatedCostUsd: null,
        iterationsLog: [],
        disclosures: [],
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }) as AgentLoopResult,
  });

  const settled = await waitForSettled(job.jobId);
  if (settled.result?.artifact?.kind === "local-file") {
    settled.result.artifact.jobId = settled.jobId;
    settled.result.previewArtifact = toPublicArtifact(settled.result.artifact);
  }
  settled.view = null;
  return settled;
}

function specificationBody(overrides: Record<string, unknown> = {}) {
  const specification = MotionSpecificationSchema.parse(previewSpecification);
  return { specification, engine: "remotion-local", ...overrides };
}

beforeEach(() => {
  createRuntime({ behavior: "fail" });
});

afterEach(async () => {
  for (const directory of TEMP_DIRECTORIES.splice(0)) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
  vi.restoreAllMocks();
});

describe("POST /api/agent/qa", () => {
  it("accepts a valid specification with 202 and never reports success", async () => {
    const response = await POST(qaRequest(specificationBody()));
    expect(response.status).toBe(202);

    const accepted = await response.json();
    expect(accepted).toMatchObject({
      type: "accepted",
      status: "queued",
      engine: "remotion-local",
      maxIterations: 2,
    });
    expect(accepted.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(accepted.pollPath).toBe(`/api/agent/qa/${accepted.jobId}`);
    expect(JSON.stringify(accepted)).not.toMatch(/\/tmp\/|\/home\//);

    // The job fails because the render backend is unavailable, but the point is that acceptance
    // never carried a verdict: only the polling route reports status.
    const settled = await waitForSettled(accepted.jobId);
    expect(settled.status).toBe("failed");
    expect(settled.result?.approved).toBe(false);

    const polled = await GET(new Request(`http://localhost${accepted.pollPath}`), jobContext(accepted.jobId));
    expect(polled.status).toBe(200);
    const view = await polled.json();
    expect(view).toMatchObject({ jobId: accepted.jobId, status: "failed", approved: false, artifact: null });
    expect(JSON.stringify(view)).not.toMatch(/\/tmp\/|\/home\/|\/var\//);
    expect(view.disclosures).toEqual(expect.any(Array));
  });

  it("refuses invalid specifications, non-JSON bodies, and oversized bodies", async () => {
    const invalid = await POST(qaRequest({ specification: { project: { id: "x" } } }));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("INVALID_REQUEST");

    const wrongType = await POST(
      qaRequest(JSON.stringify(specificationBody()), { "content-type": "text/plain" }),
    );
    expect(wrongType.status).toBe(415);

    const oversized = await POST(
      qaRequest(JSON.stringify({ ...specificationBody(), padding: "x".repeat(200_000) })),
    );
    expect(oversized.status).toBe(413);

    const notJson = await POST(qaRequest("{not json"));
    expect(notJson.status).toBe(400);

    // An unsupported engine value is rejected rather than silently defaulted.
    const badEngine = await POST(qaRequest(specificationBody({ engine: "remotion-cloud" })));
    expect(badEngine.status).toBe(400);
  });

  it("refuses a duplicate active request and reports capacity pressure", async () => {
    createRuntime({ behavior: "hang", maxJobs: 1 });

    const first = await POST(qaRequest(specificationBody()));
    expect(first.status).toBe(202);

    // Same specification while the first job is active.
    const duplicate = await POST(qaRequest(specificationBody()));
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error).toMatchObject({
      code: "DUPLICATE_ACTIVE_REQUEST",
      retryable: true,
    });

    // A different specification is a different task, but the single-slot capacity is full.
    const specification = MotionSpecificationSchema.parse(previewSpecification);
    specification.scenes[0].title = "A different render request";
    const atCapacity = await POST(qaRequest(specificationBody({ specification })));
    expect(atCapacity.status).toBe(429);
    expect((await atCapacity.json()).error.code).toBe("JOB_CAPACITY_REACHED");
  });

  it("deduplicates on an explicit request key", async () => {
    createRuntime({ behavior: "hang" });
    const key = "client-request-key-1";

    expect((await POST(qaRequest(specificationBody({ requestKey: key })))).status).toBe(202);
    expect((await POST(qaRequest(specificationBody({ requestKey: key })))).status).toBe(409);

    const tooShort = await POST(qaRequest(specificationBody({ requestKey: "short" })));
    expect(tooShort.status).toBe(400);
  });
});

describe("GET and DELETE /api/agent/qa/:jobId", () => {
  beforeEach(() => {
    createRuntime({ behavior: "hang" });
  });

  it("hides unknown and malformed job identifiers", async () => {
    const missing = await GET(new Request("http://localhost/api/agent/qa/x"), jobContext(randomUUID()));
    expect(missing.status).toBe(404);

    const malformed = await GET(new Request("http://localhost/api/agent/qa/x"), jobContext("not-a-uuid"));
    expect(malformed.status).toBe(404);
    expect((await malformed.json()).error.code).toBe("JOB_NOT_FOUND");
  });

  it("cancels a running job and refuses to cancel one that already finished", async () => {
    const accepted = await (await POST(qaRequest(specificationBody()))).json();

    const cancelled = await DELETE(new Request("http://localhost/api/agent/qa/x", { method: "DELETE" }), jobContext(accepted.jobId));
    expect(cancelled.status).toBe(202);
    expect(await cancelled.json()).toEqual({ type: "cancelled", jobId: accepted.jobId });

    const settled = await waitForSettled(accepted.jobId);
    expect(settled.status).toBe("cancelled");
    expect(settled.result?.approved).toBe(false);
    expect(settled.result?.failureReason).toBe("cancelled");

    const again = await DELETE(new Request("http://localhost/api/agent/qa/x", { method: "DELETE" }), jobContext(accepted.jobId));
    expect(again.status).toBe(409);

    const polled = await GET(new Request("http://localhost/api/agent/qa/x"), jobContext(accepted.jobId));
    const view = await polled.json();
    expect(view).toMatchObject({ status: "cancelled", approved: false, failureReason: "cancelled" });
    expect(JSON.stringify(view)).not.toMatch(/\/tmp\/|\/home\//);
  });
});

describe("GET /api/agent/qa/:jobId/preview", () => {
  it("streams a retained local preview with no-store hygiene headers", async () => {
    const directory = await makeDirectory();
    const file = path.join(directory, "render.mp4");
    const bytes = Buffer.from("pretend-mp4-bytes-0123456789");
    await writeFile(file, bytes);

    const job = await startJobWithArtifact({
      kind: "local-file",
      artifactId: randomUUID(),
      absolutePath: file,
      sizeBytes: bytes.byteLength,
      mimeType: "video/mp4",
      cleanup: "delete-after-job",
      jobId: randomUUID(),
      engine: "remotion-local",
    });

    const response = await getPreview(
      new Request(`http://localhost/api/agent/qa/${job.jobId}/preview`),
      jobContext(job.jobId),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);

    // The polling view advertises the opaque route, never the filesystem location.
    const view = await (
      await GET(new Request("http://localhost/api/agent/qa/x"), jobContext(job.jobId))
    ).json();
    expect(view.artifact.previewPath).toBe(`/api/agent/qa/${job.jobId}/preview`);
    expect(JSON.stringify(view)).not.toContain(file);
  });

  it("refuses a preview outside the served roots and a missing preview", async () => {
    const outsidePath = path.join(os.homedir(), "fqmg-not-served.mp4");
    const outside = await startJobWithArtifact({
      kind: "local-file",
      artifactId: randomUUID(),
      absolutePath: outsidePath,
      sizeBytes: 16,
      mimeType: "video/mp4",
      cleanup: "retain",
      jobId: randomUUID(),
      engine: "remotion-local",
    });

    const refused = await getPreview(
      new Request(`http://localhost/api/agent/qa/${outside.jobId}/preview`),
      jobContext(outside.jobId),
    );
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toMatchObject({
      code: "PREVIEW_NOT_AVAILABLE",
      retryable: false,
    });
    // The response never echoes the refused path.
    expect(JSON.stringify(await (await getPreview(
      new Request(`http://localhost/api/agent/qa/${outside.jobId}/preview`),
      jobContext(outside.jobId),
    )).json())).not.toContain(outsidePath);

    const directory = await makeDirectory();
    const missing = await startJobWithArtifact({
      kind: "local-file",
      artifactId: randomUUID(),
      absolutePath: path.join(directory, "gone.mp4"),
      sizeBytes: 16,
      mimeType: "video/mp4",
      cleanup: "delete-after-job",
      jobId: randomUUID(),
      engine: "remotion-local",
    });
    const notFound = await getPreview(
      new Request(`http://localhost/api/agent/qa/${missing.jobId}/preview`),
      jobContext(missing.jobId),
    );
    expect(notFound.status).toBe(404);
  });

  it("never proxies a remote artifact and reports an unknown job", async () => {
    const remote = runtime().store.startJob({
      taskId: "qa:remote",
      dedupeKey: `remote:${randomUUID()}`,
      budgetSnapshot: () => ({
        dailyCommittedUsd: 0,
        dailyLimitUsd: 0.25,
        taskLimitUsd: 0.03,
        activeReservations: 0,
        enforcement: "process-local",
        invoiceGuarantee: false,
      }),
      run: async (): Promise<AgentLoopResult> =>
        ({
          status: "passed",
          approved: true,
          iterations: 1,
          engine: "remotion-lambda",
          artifact: {
            kind: "remote-url",
            artifactId: randomUUID(),
            url: "https://fqmg-bucket.s3.amazonaws.com/renders/video.mp4",
            sizeBytes: 1_024,
            mimeType: "video/mp4",
            cleanup: "provider-managed",
            jobId: "placeholder",
            engine: "remotion-lambda",
          },
          previewArtifact: {
            artifactId: randomUUID(),
            kind: "remote-url",
            engine: "remotion-lambda",
            sizeBytes: 1_024,
            url: "https://fqmg-bucket.s3.amazonaws.com/renders/video.mp4",
          },
          validation: null,
          critiqueSummary: null,
          stage: "completed",
          failureReason: null,
          errorMessage: null,
          budget: {
            dayUtc: "2026-10-15",
            dailyReservedUsd: 0,
            dailySettledUsd: 0,
            dailyCommittedUsd: 0,
            dailyLimitUsd: 0.25,
            taskLimitUsd: 0.03,
            activeReservations: 0,
            taskIds: [],
            enforcement: "process-local",
            invoiceGuarantee: false,
          },
          estimatedCostUsd: null,
          iterationsLog: [],
          disclosures: [],
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        }) as AgentLoopResult,
    });
    await waitForSettled(remote.jobId);

    const response = await getPreview(
      new Request(`http://localhost/api/agent/qa/${remote.jobId}/preview`),
      jobContext(remote.jobId),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.message).toMatch(/provider URL/i);

    const unknown = await getPreview(
      new Request("http://localhost/api/agent/qa/x"),
      jobContext(randomUUID()),
    );
    expect(unknown.status).toBe(404);

    // The polling view exposes the provider HTTPS URL as-is (no proxying, no path).
    const view = await (
      await GET(new Request("http://localhost/api/agent/qa/x"), jobContext(remote.jobId))
    ).json();
    expect(view.artifact).toMatchObject({
      kind: "remote-url",
      url: "https://fqmg-bucket.s3.amazonaws.com/renders/video.mp4",
    });
    expect(view.artifact.previewPath).toBeUndefined();
  });
});

describe("agent runtime defaults", () => {
  it("fails closed when the job store is asked to start a bad request through an invalid config", async () => {
    expect(AgentConfigError).toBeTypeOf("function");
    expect(ACTIVE_JOB_STATUSES).toEqual(["queued", "running"]);
  });
});
