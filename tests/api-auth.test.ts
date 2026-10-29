import { afterAll, describe, expect, it } from "vitest";
import { createSessionToken, hashPassword } from "@/auth/session";

/**
 * Phase 3 acceptance: authentication boundary.
 *
 * Written failing-first (2026-10-27): before this phase no route checked any
 * identity, so every 401 expectation below was a 2xx/4xx business response.
 * Identity comes ONLY from a verified session cookie — never from the body or
 * client-controlled headers.
 */

const PREVIOUS_ENV = { ...process.env };

// Configure two test users before the modules read the environment (they read
// per call, so this also works for hot reloads inside the suite).
process.env.AUTH_SECRET = "test-auth-secret-0123456789-0123456789-0123456789";
process.env.FQMG_USERS = `alice:${hashPassword("pw-alice-123")},bob:${hashPassword("pw-bob-456")}`;
delete process.env.AUTH_ENABLED;

const SESSION_COOKIE = "fqmg_session";

function requestFor(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  cookie?: string,
): Request {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("phase 3: every API route rejects unauthenticated callers with 401", () => {
  it("returns 401 on POST /api/generate without a session", async () => {
    const { POST } = await import("@/app/api/generate/route");
    const response = await POST(requestFor("POST", "/api/generate", { prompt: "اكتب انيميشن" }));
    expect(response.status).toBe(401);
  });

  it("returns 401 on POST /api/plan without a session", async () => {
    const { POST } = await import("@/app/api/plan/route");
    const response = await POST(requestFor("POST", "/api/plan", { prompt: "Create a product explainer." }));
    expect(response.status).toBe(401);
  });

  it("returns 401 on GET /api/voice/providers without a session", async () => {
    const { GET } = await import("@/app/api/voice/providers/route");
    const response = await GET(requestFor("GET", "/api/voice/providers"));
    expect(response.status).toBe(401);
  });

  it("returns 401 on POST /api/voice/synthesize without a session (before body parsing)", async () => {
    const { POST } = await import("@/app/api/voice/synthesize/route");
    const response = await POST(requestFor("POST", "/api/voice/synthesize", {}));
    expect(response.status).toBe(401);
  });

  it("returns 401 on GET /api/voice/audio/{id} without a session", async () => {
    const { GET } = await import("@/app/api/voice/audio/[id]/route");
    const response = await GET(requestFor("GET", "/api/voice/audio/3fa85f64-5717-4562-b3fc-2c963f66afa6"), {
      params: Promise.resolve({ id: "3fa85f64-5717-4562-b3fc-2c963f66afa6" }),
    });
    expect(response.status).toBe(401);
  });

  it("returns 401 on POST /api/agent/qa without a session", async () => {
    const { POST } = await import("@/app/api/agent/qa/route");
    const response = await POST(requestFor("POST", "/api/agent/qa", {}));
    expect(response.status).toBe(401);
  });

  it("returns 401 on GET and DELETE /api/agent/qa/{jobId} without a session", async () => {
    const { GET, DELETE } = await import("@/app/api/agent/qa/[jobId]/route");
    const context = { params: Promise.resolve({ jobId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" }) };
    expect((await GET(requestFor("GET", "/api/agent/qa/x"), context)).status).toBe(401);
    expect((await DELETE(requestFor("DELETE", "/api/agent/qa/x"), context)).status).toBe(401);
  });

  it("returns 401 on GET /api/agent/qa/{jobId}/preview without a session", async () => {
    const { GET } = await import("@/app/api/agent/qa/[jobId]/preview/route");
    const response = await GET(requestFor("GET", "/api/agent/qa/x/preview"), {
      params: Promise.resolve({ jobId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" }),
    });
    expect(response.status).toBe(401);
  });

  it("the legacy /api/lambda/* render routes are gone (phase 6 unification)", async () => {
    // the routes were removed with the old composition; importing their module must fail
    const deletedRouteSpecifier = "@/app/api/lambda/render/route";
    let importFailed = false;
    try {
      await import(deletedRouteSpecifier);
    } catch {
      importFailed = true;
    }
    expect(importFailed).toBe(true);
  });

  it("never accepts identity from client-controlled headers or body", async () => {
    const { POST } = await import("@/app/api/plan/route");
    const request = requestFor("POST", "/api/plan", {
      prompt: "Create a product explainer.",
      username: "alice",
    });
    request.headers.set("x-fqmg-user", "alice");
    const response = await POST(request);
    expect(response.status).toBe(401);
  });
});

describe("phase 3: session lifecycle", () => {
  it("issues a cookie on valid login and the session then grants access", async () => {
    const { POST: loginPost } = await import("@/app/api/auth/login/route");
    const loginResponse = await loginPost(
      requestFor("POST", "/api/auth/login", { username: "alice", password: "pw-alice-123" }),
    );
    expect(loginResponse.status).toBe(200);
    const setCookie = loginResponse.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("fqmg_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");

    const token = /fqmg_session=([^;]+)/.exec(setCookie)?.[1];
    expect(token).toBeTruthy();

    const { POST: planPost } = await import("@/app/api/plan/route");
    const planResponse = await planPost(
      requestFor(
        "POST",
        "/api/plan",
        { prompt: "Create a concise product explainer.", durationSeconds: 8 },
        `${SESSION_COOKIE}=${token}`,
      ),
    );
    expect(planResponse.status).toBe(200);
  });

  it("rejects a wrong password and an unknown user with a generic 401", async () => {
    const { POST: loginPost } = await import("@/app/api/auth/login/route");
    const wrongPassword = await loginPost(
      requestFor("POST", "/api/auth/login", { username: "alice", password: "wrong-password" }),
    );
    expect(wrongPassword.status).toBe(401);
    const unknownUser = await loginPost(
      requestFor("POST", "/api/auth/login", { username: "mallory", password: "whatever-123" }),
    );
    expect(unknownUser.status).toBe(401);
    const body = (await wrongPassword.json()) as { error?: { message?: string } };
    // Generic on purpose: identical message for unknown user and wrong password.
    expect(body.error?.message).toBe("Invalid username or password.");
  });

  it("rejects a forged cookie signature", async () => {
    const { POST: planPost } = await import("@/app/api/plan/route");
    const response = await planPost(
      requestFor(
        "POST",
        "/api/plan",
        { prompt: "Create a product explainer." },
        `${SESSION_COOKIE}=eyJhbGc6InRlc3QifQ.deadbeefdeadbeef`,
      ),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a token signed for a different secret", async () => {
    const { POST: planPost } = await import("@/app/api/plan/route");
    const foreign = createSessionToken("alice", 3_600_000, "another-secret-0123456789-0123456789");
    const response = await planPost(
      requestFor("POST", "/api/plan", { prompt: "Create a product explainer." }, `${SESSION_COOKIE}=${foreign}`),
    );
    expect(response.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const { POST: planPost } = await import("@/app/api/plan/route");
    const expired = createSessionToken("alice", -1_000, process.env.AUTH_SECRET!);
    const response = await planPost(
      requestFor("POST", "/api/plan", { prompt: "Create a product explainer." }, `${SESSION_COOKIE}=${expired}`),
    );
    expect(response.status).toBe(401);
  });

  it("revokes access when the user is removed from FQMG_USERS", async () => {
    const { POST: planPost } = await import("@/app/api/plan/route");
    const token = createSessionToken("bob", 3_600_000, process.env.AUTH_SECRET!);
    process.env.FQMG_USERS = `alice:${hashPassword("pw-alice-123")}`;
    const response = await planPost(
      requestFor("POST", "/api/plan", { prompt: "Create a product explainer." }, `${SESSION_COOKIE}=${token}`),
    );
    expect(response.status).toBe(401);
  });

  it("fails closed when AUTH_SECRET is missing while auth is enforced", async () => {
    const { POST: planPost } = await import("@/app/api/plan/route");
    const token = createSessionToken("alice", 3_600_000, process.env.AUTH_SECRET!);
    delete process.env.AUTH_SECRET;
    try {
      const response = await planPost(
        requestFor("POST", "/api/plan", { prompt: "Create a product explainer." }, `${SESSION_COOKIE}=${token}`),
      );
      expect(response.status).toBe(401);
    } finally {
      process.env.AUTH_SECRET = "test-auth-secret-0123456789-0123456789-0123456789";
    }
  });

  it("AUTH_ENABLED=0 is the explicit development escape hatch", async () => {
    const { POST: planPost } = await import("@/app/api/plan/route");
    process.env.AUTH_ENABLED = "0";
    try {
      const response = await planPost(
        requestFor("POST", "/api/plan", { prompt: "Create a concise product explainer.", durationSeconds: 8 }),
      );
      expect(response.status).toBe(200);
    } finally {
      delete process.env.AUTH_ENABLED;
    }
  });
});

afterAll(() => {
  process.env = PREVIOUS_ENV;
});
