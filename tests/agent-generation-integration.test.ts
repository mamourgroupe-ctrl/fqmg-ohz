import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This suite exercises business logic, not the auth boundary: the explicit
// development escape keeps the handlers reachable (phase 3 covers 401/403/429
// in tests/api-auth.test.ts, tests/api-authorization.test.ts, tests/api-rate-limit.test.ts).
process.env.AUTH_ENABLED = "0";
import { generateObject, streamText } from "ai";
import { selectWorkingModel } from "@/lib/model-router";
import { MOTION_RULES, getMotionRulesPromptSection } from "@/agent/motion-rules";
import { POST } from "@/app/api/generate/route";

/**
 * Proves the MOTION_RULES policy reaches the two existing generation paths (streamed initial
 * generation and the non-streaming follow-up edit) without introducing a second generation
 * system. The provider SDK is mocked, so nothing leaves the process.
 */

vi.mock("@/lib/model-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/model-router")>()),
  selectWorkingModel: vi.fn(),
}));

vi.mock("ai", () => ({
  generateObject: vi.fn(),
  streamText: vi.fn(),
}));

// The skills registry is markdown-backed; the route only needs its three entry points here.
vi.mock("@/skills", () => ({
  getCombinedSkillContent: vi.fn(() => ""),
  SKILL_DETECTION_PROMPT: "",
  SKILL_NAMES: ["test"],
}));

const VALID_CODE = [
  "import { AbsoluteFill } from 'remotion';",
  "",
  "export const FqmgScene = () => {",
  "  return (<AbsoluteFill style={{ background: '#101828' }} />);",
  "};",
].join("\n");

function modelSelection() {
  return {
    model: {} as Awaited<ReturnType<typeof selectWorkingModel>>["model"],
    entry: { provider: "ollama", model: "local-model", fullName: "ollama:local-model" },
    attempts: 1,
  };
}

function request(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "Design a vertical promo", model: "local-model", ...body }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(selectWorkingModel).mockResolvedValue(modelSelection());
  vi.mocked(streamText).mockReturnValue({
    toUIMessageStreamResponse: () =>
      new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } }),
  } as unknown as ReturnType<typeof streamText>);
  // The route uses generateObject for three different jobs; reply per schema instead of per call.
  vi.mocked(generateObject).mockImplementation((async (options: {
    schema?: { shape?: Record<string, unknown>; options?: unknown };
  }) => {
    const shape = Object.keys(options.schema?.shape ?? {});
    if (shape.includes("valid")) return { object: { valid: true } };
    if (shape.includes("skills")) return { object: { skills: [] } };
    return { object: { type: "full", code: VALID_CODE, summary: "Reworked the layout." } };
  }) as unknown as typeof generateObject);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generation prompt integration", () => {
  it("appends the shared motion rules to the initial generation system prompt", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);

    expect(streamText).toHaveBeenCalledTimes(1);
    const call = vi.mocked(streamText).mock.calls[0][0] as { system: string; maxOutputTokens: number };
    const section = getMotionRulesPromptSection();

    expect(call.system).toContain(section);
    for (const rule of MOTION_RULES) {
      expect(call.system).toContain(rule.id);
    }
    expect(call.maxOutputTokens).toBe(16_000);
    // The initial path never uses the follow-up prompt, and the endpoint never renders: the
    // visual QA loop runs as a separate job.
    expect(generateObject).not.toHaveBeenCalledWith(
      expect.objectContaining({ system: expect.stringContaining("MOTION RULES") }),
    );
  });

  it("appends the same rules to the non-streaming follow-up edit prompt", async () => {
    const response = await POST(
      request({
        prompt: "Make the headline bigger",
        isFollowUp: true,
        currentCode: VALID_CODE,
        conversationHistory: [{ role: "user", content: "Design a vertical promo" }],
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.metadata.editType).toBe("full_replacement");

    // Generation is still a single follow-up call: no second generation system was introduced.
    const editCalls = vi.mocked(generateObject).mock.calls.filter(
      (call) => (call[0] as { maxOutputTokens?: number }).maxOutputTokens === 16_000 &&
        typeof (call[0] as { system?: string }).system === "string" &&
        (call[0] as { system: string }).system.includes("MOTION RULES"),
    );
    const call = editCalls[0][0] as { system: string; maxOutputTokens: number };
    expect(call.system).toContain(getMotionRulesPromptSection());
    expect(call.maxOutputTokens).toBe(16_000);
    expect(streamText).not.toHaveBeenCalled();
  });
});
