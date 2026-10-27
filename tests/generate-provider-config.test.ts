import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This suite exercises business logic, not the auth boundary: the explicit
// development escape keeps the handlers reachable (phase 3 covers 401/403/429
// in tests/api-auth.test.ts, tests/api-authorization.test.ts, tests/api-rate-limit.test.ts).
process.env.AUTH_ENABLED = "0";
import { generateObject } from "ai";
import { ModelRouterError, selectWorkingModel } from "@/lib/model-router";
import { POST } from "@/app/api/generate/route";

const LOCAL_QWEN_MODEL =
  "hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M";

vi.mock("@/lib/model-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/model-router")>(),
  selectWorkingModel: vi.fn(),
}));
vi.mock("ai", () => ({ generateObject: vi.fn(), streamText: vi.fn() }));
vi.mock("@/skills", () => ({
  getCombinedSkillContent: vi.fn(),
  SKILL_DETECTION_PROMPT: "",
  SKILL_NAMES: ["test"],
}));

const request = () => new Request("http://localhost/api/generate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "Hello", model: LOCAL_QWEN_MODEL }),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe("generation provider configuration", () => {
  it("returns an actionable JSON error when no provider is configured", async () => {
    vi.mocked(selectWorkingModel).mockRejectedValueOnce(new ModelRouterError(
      "Configure OLLAMA_BASE_URL in .env.local", "AI_NOT_CONFIGURED",
    ));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Configure OLLAMA_BASE_URL in .env.local", code: "AI_NOT_CONFIGURED",
      type: "provider_unavailable",
    });
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("preserves the code and guidance when configured providers are unavailable", async () => {
    vi.mocked(selectWorkingModel).mockRejectedValueOnce(new ModelRouterError(
      "Check the provider URL and network access.", "AI_UNAVAILABLE",
    ));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Check the provider URL and network access.",
      code: "AI_UNAVAILABLE",
      type: "provider_unavailable",
    });
  });

  it.each([401, undefined])("sanitizes unexpected provider errors (status %s) in responses and logs", async (statusCode) => {
    vi.mocked(selectWorkingModel).mockRejectedValueOnce(Object.assign(
      new Error("Provider rejected secret-api-token"), { statusCode },
    ));
    const response = await POST(request());
    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload).toMatchObject({ code: "AI_UNAVAILABLE", type: "provider_unavailable" });
    expect(payload.error).toBe(statusCode === 401
      ? "The AI provider rejected the configured account (HTTP 401). Verify the provider endpoint, account access, and selected model."
      : "The AI provider could not complete generation. Check its availability and configuration, then retry.");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret-api-token");
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("lets a selected Ollama model reach validation without OPENAI_API_KEY", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      vi.mocked(selectWorkingModel).mockResolvedValueOnce({
        model: {} as Awaited<ReturnType<typeof selectWorkingModel>>["model"],
        entry: {
          provider: "ollama",
          model: LOCAL_QWEN_MODEL,
          fullName: `ollama:${LOCAL_QWEN_MODEL}`,
        },
        attempts: 1,
      });
      vi.mocked(generateObject).mockResolvedValueOnce({ object: { valid: false } } as Awaited<ReturnType<typeof generateObject>>);
      const response = await POST(request());
      expect(selectWorkingModel).toHaveBeenCalledWith(LOCAL_QWEN_MODEL);
      expect(generateObject).toHaveBeenCalledOnce();
      expect((await response.json()).type).toBe("validation");
    } finally {
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
    }
  });
});
