import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/model-router", () => {
  class ModelRouterError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  class ModelSelectionError extends ModelRouterError {}
  return {
    ModelRouterError,
    ModelSelectionError,
    selectWorkingModel: vi.fn(async () => ({
      model: "mock-model",
      entry: { provider: "mock", model: "mock", fullName: "mock:model" },
      attempts: 1,
    })),
  };
});

vi.mock("ai", () => ({
  generateObject: vi.fn(async () => ({ object: { valid: true, skills: [] } })),
  streamText: vi.fn(() => ({
    toUIMessageStreamResponse: () =>
      new Response('data: {"type":"start"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  })),
}));

import { POST as generatePost } from "@/app/api/generate/route";

/**
 * Phase 2: /api/generate input validation and log hygiene.
 *
 * The mocks above keep provider/router code out; every test below targets the
 * request-boundary behavior (size caps, schema, image inspection, logging).
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonRequest(payload: unknown): Request {
  return new Request("http://localhost:3000/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** Minimal header-only PNG: signature + IHDR with real dimensions (no pixel data needed). */
function pngDataUrl(width: number, height: number, fillerBytes = 48): string {
  const buffer = Buffer.alloc(24 + fillerBytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/generate request boundary (phase 2)", () => {
  it("rejects an oversized body with 413 before any provider call", async () => {
    const response = await generatePost(jsonRequest({ prompt: "a".repeat(34 * 1024 * 1024) }));
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error?: string; type?: string };
    expect(body.error).toBeTruthy();
  });

  it("rejects a non-JSON content type with 415", async () => {
    const request = new Request("http://localhost:3000/api/generate", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ prompt: "اكتب انيميشن" }),
    });
    const response = await generatePost(request);
    expect(response.status).toBe(415);
  });

  it("rejects a malformed JSON body with 400", async () => {
    const request = new Request("http://localhost:3000/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken json",
    });
    const response = await generatePost(request);
    expect(response.status).toBe(400);
  });

  it("rejects a schema-incompatible body with 400 and structured issues", async () => {
    const response = await generatePost(jsonRequest({ prompt: 42, isFollowUp: "yes" }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error?: string;
      issues?: Array<{ path: string; message: string }>;
    };
    expect(body.error).toBeTruthy();
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues?.some((issue) => issue.path === "prompt")).toBe(true);
  });

  it("rejects an unsupported image data URL with 400", async () => {
    const response = await generatePost(
      jsonRequest({ prompt: "اكتب انيميشن شعار", frameImages: ["data:text/html;base64,PGI+"] }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBeTruthy();
  });

  it("rejects an image with invalid magic bytes with 400", async () => {
    const response = await generatePost(
      jsonRequest({ prompt: "اكتب انيميشن شعار", frameImages: ["data:image/png;base64,AAAA"] }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects an oversized image with 400", async () => {
    const response = await generatePost(
      jsonRequest({
        prompt: "اكتب انيميشن شعار",
        frameImages: [pngDataUrl(256, 256, 2 * 1024 * 1024 + 256)],
      }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects more than the total image budget (frame images + history) with 400", async () => {
    const image = pngDataUrl(256, 256);
    const response = await generatePost(
      jsonRequest({
        prompt: "اكتب انيميشن شعار",
        frameImages: [image, image, image, image],
        conversationHistory: [
          { role: "user", content: "تحديث أول", attachedImages: [image, image] },
          { role: "user", content: "تحديث ثان", attachedImages: [image, image] },
          { role: "user", content: "تحديث ثالث", attachedImages: [image, image] },
          { role: "assistant", content: "تم" },
        ],
      }),
    );
    expect(response.status).toBe(400);
  });

  it("accepts a valid request, streams, and never logs the prompt (log hygiene)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const prompt = "اكتب انيميشن شعار احترافي يظهر تدريجيًا";
    const response = await generatePost(
      jsonRequest({
        prompt,
        frameImages: [pngDataUrl(256, 256)],
        conversationHistory: [{ role: "user", content: "ابدأ التصميم" }],
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-generation-model")).toBe("mock:model");
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toMatch(UUID_PATTERN);

    const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls]
      .map((call) => call.map((arg) => String(arg)).join(" "))
      .join("\n");
    expect(logged).not.toContain(prompt);
    expect(logged).toContain(`promptLength=${prompt.length}`);
    expect(logged).toContain(`requestId=${requestId}`);
  });
});
