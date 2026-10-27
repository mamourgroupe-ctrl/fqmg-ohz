import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { createSessionToken } from "@/auth/session";
import { __resetRateLimitsForTests } from "@/auth/rate-limit";

/**
 * Phase 3: the src/proxy.ts outer gate (Next.js 16 renamed middleware to
 * proxy, nodejs runtime). Handlers re-verify everything themselves; this file
 * covers the gate's own behavior only.
 */

const PREVIOUS_ENV = { ...process.env };
const SECRET = "test-auth-secret-0123456789-0123456789-0123456789";
process.env.AUTH_SECRET = SECRET;
process.env.FQMG_USERS = "alice:x";
delete process.env.AUTH_ENABLED;

const { default: proxy } = await import("@/proxy");
const { NextRequest: NextRequestCtor } = await import("next/server");

function nextRequest(path: string, cookie?: string, ip = "192.0.2.1"): NextRequest {
  const headers: Record<string, string> = { "x-forwarded-for": ip };
  if (cookie) headers.cookie = cookie;
  return new NextRequestCtor(`http://localhost:3000${path}`, { headers }) as NextRequest;
}

const isNext = (response: { status: number }): boolean => response.status === 200;

beforeEach(() => {
  __resetRateLimitsForTests();
});

describe("phase 3: src/proxy.ts outer gate", () => {
  it("blocks unauthenticated /api calls with 401 and passes the login route", () => {
    const blocked = proxy(nextRequest("/api/plan"));
    expect(blocked.status).toBe(401);

    const login = proxy(nextRequest("/api/auth/login"));
    expect(isNext(login)).toBe(true);

    const logout = proxy(nextRequest("/api/auth/logout"));
    expect(isNext(logout)).toBe(true);
  });

  it("passes a valid session cookie through to the app", () => {
    const token = createSessionToken("alice", 3_600_000, SECRET);
    const response = proxy(nextRequest("/api/plan", `fqmg_session=${token}`));
    expect(isNext(response)).toBe(true);
  });

  it("disables itself under the documented AUTH_ENABLED=0 dev escape", () => {
    process.env.AUTH_ENABLED = "0";
    try {
      const response = proxy(nextRequest("/api/plan"));
      expect(isNext(response)).toBe(true);
    } finally {
      delete process.env.AUTH_ENABLED;
    }
  });

  it("rate limits by client IP before the session check", () => {
    for (let index = 0; index < 120; index += 1) {
      proxy(nextRequest("/api/plan", undefined, "203.0.113.50"));
    }
    const blocked = proxy(nextRequest("/api/plan", undefined, "203.0.113.50"));
    expect(blocked.status).toBe(429);
    // a different IP is not throttled by the first IP's window (still needs a session)
    const token = createSessionToken("alice", 3_600_000, SECRET);
    const otherIp = proxy(nextRequest("/api/plan", `fqmg_session=${token}`, "198.51.100.77"));
    expect(isNext(otherIp)).toBe(true);
  });
});

afterAll(() => {
  process.env = PREVIOUS_ENV;
});
