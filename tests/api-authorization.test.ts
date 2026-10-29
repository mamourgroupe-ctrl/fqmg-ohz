import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken } from "@/auth/session";
import { recordAudioOwner } from "@/auth/ownership";

/**
 * Phase 3 acceptance: authorization — every job/audio/preview belongs to one
 * user; nobody else can reach it. The owner is taken from the verified session
 * only: a client-supplied owner field must be ignored.
 */

const PREVIOUS_ENV = { ...process.env };
const SECRET = "test-auth-secret-0123456789-0123456789-0123456789";

process.env.AUTH_SECRET = SECRET;
process.env.FQMG_USERS = `alice:x,bob:x`;
delete process.env.AUTH_ENABLED;

vi.mock("@/agent/runtime", () => ({
  getAgentRuntime: () => harness,
}));

vi.mock("@/agent/loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/agent/loop")>();
  return {
    ...actual,
    runAgentLoop: vi.fn(async () => ({
      jobId: "loop-stub",
      taskId: "loop-stub",
      status: "passed",
      verdict: "pass",
      iterations: 1,
      stages: [],
      disclosures: [],
    })),
    AGENT_STAGES: actual.AGENT_STAGES,
    AGENT_FAILURE_REASONS: actual.AGENT_FAILURE_REASONS,
    AgentRequestError: actual.AgentRequestError,
  };
});

const { POST: qaPost } = await import("@/app/api/agent/qa/route");
const { GET: qaGet, DELETE: qaDelete } = await import("@/app/api/agent/qa/[jobId]/route");
const { GET: previewGet } = await import("@/app/api/agent/qa/[jobId]/preview/route");
const { GET: audioGet } = await import("@/app/api/voice/audio/[id]/route");
const { AgentJobStore } = await import("@/agent/job-store");
const { BudgetLedger } = await import("@/agent/budget");
const { AGENT_CONFIG_DEFAULTS } = await import("@/agent/config");
const { createDisabledVisionProvider } = await import("@/agent/vision-providers");
const { createDisabledMotionRepairProvider } = await import("@/agent/repair-provider");

const store = new AgentJobStore({ ttlMs: 600_000 });
const budget = new BudgetLedger({
  policy: {
    dailyLimitUsd: AGENT_CONFIG_DEFAULTS.dailyBudgetUsd,
    taskLimitUsd: AGENT_CONFIG_DEFAULTS.taskBudgetUsd,
    userDailyLimitUsd: AGENT_CONFIG_DEFAULTS.dailyBudgetUsd,
  },
});

const harness = {
  config: AGENT_CONFIG_DEFAULTS,
  priceBook: { verifiedAt: null, entries: new Map() },
  budget,
  visionProvider: createDisabledVisionProvider(AGENT_CONFIG_DEFAULTS.visionModelId),
  repairProvider: createDisabledMotionRepairProvider(),
  store,
  getRenderBackend: () => {
    throw new Error("render backend must not be reached in authorization tests");
  },
};

const ALICE = `fqmg_session=${createSessionToken("alice", 3_600_000, SECRET)}`;
const BOB = `fqmg_session=${createSessionToken("bob", 3_600_000, SECRET)}`;

function jsonRequest(path: string, body: unknown, cookie?: string): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

import previewSpecification from "../templates/phase-one-preview.json";

const validSpecification = previewSpecification;

let aliceJobId: string | undefined;

beforeEach(() => {
  // fresh store per test keeps job ownership assertions isolated
  process.env.AUTH_SECRET = SECRET;
});

describe("phase 3: job/preview ownership", () => {
  it("records the session user as the job owner, ignoring a client-supplied owner", async () => {
    const response = await qaPost(
      jsonRequest(
        "/api/agent/qa",
        { specification: validSpecification, owner: "bob" },
        ALICE,
      ),
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { jobId: string };
    aliceJobId = body.jobId;
    const job = await store.getJob(aliceJobId!);
    expect(job?.owner).toBe("alice");
  });

  it("returns 403 when another user polls, cancels, or previews the job", async () => {
    expect(aliceJobId).toBeTruthy();
    const jobId = aliceJobId!;
    const context = { params: Promise.resolve({ jobId }) };

    const poll = await qaGet(new Request(`http://localhost:3000/api/agent/qa/${jobId}`, { headers: { cookie: BOB } }), context);
    expect(poll.status).toBe(403);

    const cancel = await qaDelete(new Request(`http://localhost:3000/api/agent/qa/${jobId}`, { method: "DELETE", headers: { cookie: BOB } }), context);
    expect(cancel.status).toBe(403);

    const preview = await previewGet(
      new Request(`http://localhost:3000/api/agent/qa/${jobId}/preview`, { headers: { cookie: BOB } }),
      context,
    );
    expect(preview.status).toBe(403);
  });

  it("still allows the owner to poll and reports 404 (not a leak) for its missing preview", async () => {
    const jobId = aliceJobId!;
    const context = { params: Promise.resolve({ jobId }) };
    const poll = await qaGet(new Request(`http://localhost:3000/api/agent/qa/${jobId}`, { headers: { cookie: ALICE } }), context);
    expect(poll.status).toBe(200);

    const preview = await previewGet(
      new Request(`http://localhost:3000/api/agent/qa/${jobId}/preview`, { headers: { cookie: ALICE } }),
      context,
    );
    expect(preview.status).toBe(404);
  });
});

describe("phase 3: voice audio ownership", () => {
  const referenceId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

  it("returns 403 for a reference with no recorded owner (fail closed) and for another user's audio", async () => {
    const context = { params: Promise.resolve({ id: referenceId }) };
    const unowned = await audioGet(
      new Request(`http://localhost:3000/api/voice/audio/${referenceId}`, { headers: { cookie: ALICE } }),
      context,
    );
    expect(unowned.status).toBe(403);

    recordAudioOwner(referenceId, "bob");
    const someoneElses = await audioGet(
      new Request(`http://localhost:3000/api/voice/audio/${referenceId}`, { headers: { cookie: ALICE } }),
      context,
    );
    expect(someoneElses.status).toBe(403);
  });
});

afterAll(() => {
  process.env = PREVIOUS_ENV;
});
