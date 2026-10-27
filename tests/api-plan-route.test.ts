import { describe, expect, it } from "vitest";
import { POST as planPost } from "@/app/api/plan/route";

function jsonRequest(payload: unknown): Request {
  return new Request("http://localhost:3000/api/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/plan route handler (phase 2)", () => {
  it("returns 200 with a validated local plan for a valid brief", async () => {
    const response = await planPost(
      jsonRequest({
        prompt: "أنشئ إعلانًا تجاريًا أنيقًا لمنتج محلي، من دون اختراع معلومات.",
        durationSeconds: 8,
        aspectRatio: "16:9",
        language: "en",
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providerId?: string; plan?: unknown };
    expect(body.providerId).toBe("local-rules");
    expect(body.plan).toBeTruthy();
  });

  it("returns 400 with structured issues for a brief that fails validation", async () => {
    const response = await planPost(jsonRequest({ prompt: "ab" }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error?: string;
      issues?: Array<{ path: string; message: string }>;
    };
    expect(body.error).toBeTruthy();
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues?.some((issue) => issue.path === "prompt")).toBe(true);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const request = new Request("http://localhost:3000/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{definitely not json",
    });
    const response = await planPost(request);
    expect(response.status).toBe(400);
  });

  it("returns 413 for a body above the 32 KB limit", async () => {
    const response = await planPost(jsonRequest({ prompt: "a".repeat(40_000) }));
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBeTruthy();
  });
});
