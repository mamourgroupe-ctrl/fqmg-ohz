import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateObject } from "ai";
import { ModelRouterError, selectWorkingModel } from "@/lib/model-router";
import { POST } from "@/app/api/generate/route";

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
  body: JSON.stringify({ prompt: "Hello", model: "qwen2.5-coder:7b" }),
});

beforeEach(() => { vi.clearAllMocks(); });

describe("generation provider configuration", () => {
  it("returns an actionable JSON error when no provider is configured", async () => {
    vi.mocked(selectWorkingModel).mockRejectedValueOnce(new ModelRouterError(
      "Configure OLLAMA_BASE_URL in .env.local", "AI_NOT_CONFIGURED",
    ));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Configure OLLAMA_BASE_URL in .env.local", code: "AI_NOT_CONFIGURED",
    });
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("lets a selected Ollama model reach validation without OPENAI_API_KEY", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      vi.mocked(selectWorkingModel).mockResolvedValueOnce({
        model: {} as Awaited<ReturnType<typeof selectWorkingModel>>["model"],
        entry: { provider: "ollama", model: "qwen2.5-coder:7b", fullName: "ollama:qwen2.5-coder:7b" },
        attempts: 1,
      });
      vi.mocked(generateObject).mockResolvedValueOnce({ object: { valid: false } } as Awaited<ReturnType<typeof generateObject>>);
      const response = await POST(request());
      expect(selectWorkingModel).toHaveBeenCalledWith("qwen2.5-coder:7b");
      expect(generateObject).toHaveBeenCalledOnce();
      expect((await response.json()).type).toBe("validation");
    } finally {
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
    }
  });
});
