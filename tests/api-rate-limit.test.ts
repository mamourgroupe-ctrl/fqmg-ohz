import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, hashPassword } from "@/auth/session";
import { __resetRateLimitsForTests, getRatePolicy } from "@/auth/rate-limit";

/**
 * Phase 3 acceptance: per-user rate limiting — 429 when exceeded, other users
 * unaffected, window resets. The limiter is per-user (cookie-verified) and
 * per-IP for login.
 */

const PREVIOUS_ENV = { ...process.env };
const SECRET = "test-auth-secret-0123456789-0123456789-0123456789";

process.env.AUTH_SECRET = SECRET;
process.env.FQMG_USERS = `alice:${hashPassword("pw-alice-123")},bob:${hashPassword("pw-bob-456")}`;
delete process.env.AUTH_ENABLED;

const { POST: planPost } = await import("@/app/api/plan/route");
const { POST: loginPost } = await import("@/app/api/auth/login/route");

const ALICE = `fqmg_session=${createSessionToken("alice", 3_600_000, SECRET)}`;
const BOB = `fqmg_session=${createSessionToken("bob", 3_600_000, SECRET)}`;

function planRequest(cookie?: string, ip?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  if (ip) headers["x-forwarded-for"] = ip;
  return new Request("http://localhost:3000/api/plan", {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "Create a tiny product teaser.", durationSeconds: 2 }),
  });
}

beforeEach(() => {
  __resetRateLimitsForTests();
});

describe("phase 3: per-user rate limiting", () => {
  it("documents the plan policy and returns 429 with Retry-After when exceeded", async () => {
    const policy = getRatePolicy("plan");
    expect(policy.max).toBeGreaterThan(0);

    for (let index = 0; index < policy.max; index += 1) {
      const response = await planPost(planRequest(ALICE));
      expect(response.status).toBe(200);
    }
    const blocked = await planPost(planRequest(ALICE));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    const body = (await blocked.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("RATE_LIMITED");
  });

  it("does not affect another user's budget of requests", async () => {
    const policy = getRatePolicy("plan");
    for (let index = 0; index < policy.max; index += 1) {
      await planPost(planRequest(ALICE));
    }
    const otherUser = await planPost(planRequest(BOB));
    expect(otherUser.status).toBe(200);
  });

  it("allows requests again after the window passes", async () => {
    vi.useFakeTimers();
    try {
      const policy = getRatePolicy("plan");
      for (let index = 0; index < policy.max; index += 1) {
        await planPost(planRequest(ALICE));
      }
      expect((await planPost(planRequest(ALICE))).status).toBe(429);
      vi.advanceTimersByTime(policy.windowMs + 1_000);
      expect((await planPost(planRequest(ALICE))).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throttles repeated login attempts per IP", async () => {
    const policy = getRatePolicy("auth-login");
    let lastStatus = 0;
    for (let index = 0; index < policy.max + 1; index += 1) {
      const response = await loginPost(
        new Request("http://localhost:3000/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
          body: JSON.stringify({ username: "alice", password: `wrong-${index}` }),
        }),
      );
      lastStatus = response.status;
      if (index < policy.max) expect(response.status).toBe(401);
    }
    expect(lastStatus).toBe(429);
    // a different IP is not throttled by the first IP's attempts
    const otherIp = await loginPost(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.9" },
        body: JSON.stringify({ username: "alice", password: "pw-alice-123" }),
      }),
    );
    expect(otherIp.status).toBe(200);
  });
});

afterAll(() => {
  process.env = PREVIOUS_ENV;
});
