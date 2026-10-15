import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConfigError, loadAgentConfig, AGENT_CONFIG_DEFAULTS } from "@/agent/config";
import { loadPriceBook } from "@/agent/pricing";
import { createAgentRuntime } from "@/agent/runtime";

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("Network access is not allowed in unit tests.");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("agent configuration", () => {
  it("ships inert defaults: two iterations, a 3 cent task ceiling, a 25 cent daily ceiling", () => {
    const config = loadAgentConfig({});
    expect(config).toEqual(AGENT_CONFIG_DEFAULTS);
    expect(config.maxIterations).toBe(2);
    expect(config.taskBudgetUsd).toBe(0.03);
    expect(config.dailyBudgetUsd).toBe(0.25);
    expect(config.frameCount).toBe(4);
    expect(config.frameWidth).toBe(512);
    expect(config.visionEnabled).toBe(false);
    expect(config.repairEnabled).toBe(false);
    expect(config.keepFrames).toBe(false);
  });

  it("reads overrides and fails closed on malformed values", () => {
    const config = loadAgentConfig({
      AGENT_MAX_ITERATIONS: "4",
      AGENT_FRAME_COUNT: "6",
      AGENT_FRAME_WIDTH: "640",
      AGENT_TASK_BUDGET_USD: "0.02",
      AGENT_DAILY_BUDGET_USD: "0.5",
      AGENT_VISION_ENABLED: "true",
      AGENT_JOB_TTL_MS: "60000",
    });
    expect(config).toMatchObject({
      maxIterations: 4,
      frameCount: 6,
      frameWidth: 640,
      taskBudgetUsd: 0.02,
      dailyBudgetUsd: 0.5,
      visionEnabled: true,
      jobTtlMs: 60_000,
    });

    expect(() => loadAgentConfig({ AGENT_MAX_ITERATIONS: "9" })).toThrowError(AgentConfigError);
    expect(() => loadAgentConfig({ AGENT_MAX_ITERATIONS: "two" })).toThrowError(AgentConfigError);
    expect(() => loadAgentConfig({ AGENT_VISION_ENABLED: "sometimes" })).toThrowError(AgentConfigError);
    expect(() =>
      loadAgentConfig({ AGENT_TASK_BUDGET_USD: "0.5", AGENT_DAILY_BUDGET_USD: "0.25" }),
    ).not.toThrow();
    expect(() =>
      loadAgentConfig({ AGENT_MAX_FRAME_BYTES: "4000000", AGENT_MAX_TOTAL_FRAME_BYTES: "1000000" }),
    ).toThrowError(AgentConfigError);
  });

  it("ignores a partially configured price instead of inventing one", () => {
    expect(loadPriceBook({})).toEqual({ entries: [] });
    expect(
      loadPriceBook({
        AGENT_VISION_PROVIDER: "openai-compatible",
        AGENT_VISION_MODEL: "vision-model",
        AGENT_PRICE_INPUT_PER_MTOK: "1",
        // Output price missing: the whole entry is dropped.
      }),
    ).toEqual({ entries: [] });
    expect(
      loadPriceBook({
        AGENT_VISION_PROVIDER: "openai-compatible",
        AGENT_VISION_MODEL: "vision-model",
        AGENT_PRICE_INPUT_PER_MTOK: "1",
        AGENT_PRICE_OUTPUT_PER_MTOK: "2",
        AGENT_PRICE_SOURCE_URL: "https://example.invalid/pricing",
        AGENT_PRICE_VERIFIED_ON: "2026-10-15",
      }).entries,
    ).toHaveLength(1);
  });
});

describe("agent runtime wiring", () => {
  it("disables every paid provider by default and enforces the documented ceilings", () => {
    const runtime = createAgentRuntime({});

    expect(runtime.visionProvider.isConfigured).toBe(false);
    expect(runtime.visionProvider.id).toBe("disabled");
    expect(runtime.repairProvider.isConfigured).toBe(false);
    expect(runtime.priceBook.entries).toEqual([]);

    const snapshot = runtime.budget.snapshot();
    expect(snapshot).toMatchObject({
      dailyLimitUsd: 0.25,
      taskLimitUsd: 0.03,
      activeReservations: 0,
      dailyCommittedUsd: 0,
      enforcement: "process-local",
      invoiceGuarantee: false,
    });

    expect(runtime.getRenderBackend("remotion-local").engineId).toBe("remotion-local");
    expect(runtime.getRenderBackend("remotion-lambda").engineId).toBe("remotion-lambda");
    expect(runtime.store.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still disables vision when a provider is enabled without proof that it accepts images", () => {
    const base = {
      AGENT_VISION_ENABLED: "1",
      AGENT_VISION_PROVIDER: "openai-compatible",
      AGENT_VISION_MODEL: "vision-model",
      AGENT_VISION_API_KEY: "test-key",
      AGENT_VISION_BASE_URL: "https://vision.example.invalid/v1",
    };

    // Documented capability is a requirement, not an assumption.
    expect(createAgentRuntime(base).visionProvider.isConfigured).toBe(false);

    const verified = createAgentRuntime({
      ...base,
      AGENT_VISION_IMAGE_SUPPORT_VERIFIED: "1",
    });
    expect(verified.visionProvider.isConfigured).toBe(true);
    expect(verified.visionProvider.id).toBe("openai-compatible");
    expect(verified.visionProvider.modelId).toBe("vision-model");
    expect(fetchSpy).not.toHaveBeenCalled();

    // A key is still required even when the capability was confirmed.
    expect(
      createAgentRuntime({
        ...base,
        AGENT_VISION_API_KEY: "",
        AGENT_VISION_IMAGE_SUPPORT_VERIFIED: "1",
      }).visionProvider.isConfigured,
    ).toBe(false);
  });

  it("keeps the AI repair provider disabled when its provider has no credentials", () => {
    vi.stubEnv("MODEL_CHAIN", "anthropic:claude-sonnet-5");
    try {
      const runtime = createAgentRuntime({
        AGENT_REPAIR_ENABLED: "1",
        AGENT_REPAIR_MODEL: "claude-sonnet-5",
      });

      expect(runtime.repairProvider.isConfigured).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("enables the AI repair provider once repair is on and the provider is credentialed", () => {
    // The repair path reuses the existing model router, which resolves credentials from
    // process.env, so the credential is stubbed there.
    vi.stubEnv("MODEL_CHAIN", "anthropic:claude-sonnet-5");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    try {
      const runtime = createAgentRuntime({
        AGENT_REPAIR_ENABLED: "1",
        AGENT_REPAIR_MODEL: "claude-sonnet-5",
      });

      expect(runtime.repairProvider.isConfigured).toBe(true);
      expect(runtime.repairProvider.id).toContain("model-router:anthropic");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("builds a Lambda backend that stays disabled without AWS credentials", () => {
    const runtime = createAgentRuntime({});
    const lambda = runtime.getRenderBackend("remotion-lambda");
    expect(lambda.engineId).toBe("remotion-lambda");
    expect(lambda.isConfigured).toBe(false);
  });
});
