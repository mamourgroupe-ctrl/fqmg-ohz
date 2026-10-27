import { beforeAll, describe, expect, it } from "vitest";
import { POST as lambdaRenderPost } from "@/app/api/lambda/render/route";
import { POST as lambdaProgressPost } from "@/app/api/lambda/progress/route";

/**
 * Phase 2: the two Lambda routes go through the hardened executeApi contract
 * (bounded body, 400 with issues on schema failure, generic 500 without raw
 * internal error strings).
 */

function jsonRequest(payload: unknown, target: string): Request {
  return new Request(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const validRenderBody = {
  inputProps: { code: "export const A = () => null;", durationInFrames: 30, fps: 30 },
};

beforeAll(() => {
  // The render handler must hit its "not configured" guard, not a real render.
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.REMOTION_AWS_ACCESS_KEY_ID;
  delete process.env.REMOTION_AWS_SECRET_ACCESS_KEY;
});

describe("POST /api/lambda/render through executeApi (phase 2)", () => {
  it("returns 400 with structured issues for a schema-incompatible body", async () => {
    const response = await lambdaRenderPost(jsonRequest({}, "http://localhost:3000/api/lambda/render"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues?: unknown[] };
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it("returns 413 for a body above the byte cap", async () => {
    const response = await lambdaRenderPost(
      jsonRequest(
        { inputProps: { code: "x".repeat(200_000), durationInFrames: 30, fps: 30 } },
        "http://localhost:3000/api/lambda/render",
      ),
    );
    expect(response.status).toBe(413);
  });

  it("returns a generic 500 when the handler fails, without leaking the raw error", async () => {
    const response = await lambdaRenderPost(
      jsonRequest(validRenderBody, "http://localhost:3000/api/lambda/render"),
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as { type: string; message: string };
    expect(body.type).toBe("error");
    expect(body.message).toBe("Unexpected server error.");
    expect(JSON.stringify(body)).not.toContain("Set up Remotion Lambda");
  });
});

describe("POST /api/lambda/progress through executeApi (phase 2)", () => {
  it("returns 400 with structured issues for a schema-incompatible body", async () => {
    const response = await lambdaProgressPost(
      jsonRequest({ id: 42 }, "http://localhost:3000/api/lambda/progress"),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues?: unknown[] };
    expect(Array.isArray(body.issues)).toBe(true);
  });
});
