import { afterEach, describe, expect, it, vi } from "vitest";

// Business-logic suite for the wrapper contract; the auth boundary is covered
// in tests/api-auth.test.ts (phase 3).
process.env.AUTH_ENABLED = "0";
import { z } from "zod";
import { executeApi } from "@/helpers/api-response";

const schema = z.object({ n: z.number() });

function jsonRequest(payload: unknown, target = "http://localhost:3000/api/test"): Request {
  return new Request(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("executeApi error contract (phase 2)", () => {
  it("returns 200 with the wrapped payload on success", async () => {
    const handler = vi.fn(async () => ({ ok: true as const }));
    const response = await executeApi(schema, handler)(jsonRequest({ n: 3 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: "success", data: { ok: true } });
  });

  it("returns 400 with structured issues when the body fails the schema (not 500)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await executeApi(schema, async () => ({}))(jsonRequest({ n: "not-a-number" }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      type: string;
      message: string;
      issues: Array<{ path: string; message: string }>;
    };
    expect(body.type).toBe("error");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.some((issue) => issue.path === "n")).toBe(true);
    // The raw Zod report and internal details must not leak to the client.
    expect(JSON.stringify(body)).not.toContain("Expected number");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns a generic 500 when the handler throws, and logs the raw error internally", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rawMessage = "database connection failed at 10.1.2.3 with token Bearer abcdef123456";
    const response = await executeApi(schema, async () => {
      throw new Error(rawMessage);
    })(jsonRequest({ n: 1 }));
    expect(response.status).toBe(500);
    const body = (await response.json()) as { type: string; message: string };
    expect(body.type).toBe("error");
    expect(body.message).toBe("Unexpected server error.");
    expect(JSON.stringify(body)).not.toContain("database connection failed");
    // The internal log keeps the failure visible for operators, but sanitized.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain("database connection failed");
    expect(logged).not.toContain("Bearer abcdef123456");
    expect(logged).toContain("[REDACTED]");
  });

  it("returns 413 for a body over the configured byte cap", async () => {
    const response = await executeApi(schema, async () => ({}), { maxBodyBytes: 128 })(
      jsonRequest({ n: 1, filler: "x".repeat(2048) }),
    );
    expect(response.status).toBe(413);
    const body = (await response.json()) as { type: string };
    expect(body.type).toBe("error");
  });

  it("returns 415 for a non-JSON content type", async () => {
    const request = new Request("http://localhost:3000/api/test", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ n: 1 }),
    });
    const response = await executeApi(schema, async () => ({}))(request);
    expect(response.status).toBe(415);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const request = new Request("http://localhost:3000/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    const response = await executeApi(schema, async () => ({}))(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { type: string };
    expect(body.type).toBe("error");
  });
});
