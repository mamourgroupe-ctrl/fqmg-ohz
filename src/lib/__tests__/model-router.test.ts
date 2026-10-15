import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getModelChain, createModelForEntry, selectWorkingModel, hasRequiredEnvVars } from "../model-router";
import { getAIConfig } from "../ai-provider";

const {
  generateTextMock,
  createOpenAIMock,
  openAIChatMock,
  createAnthropicMock,
  anthropicModelMock,
  createAzureMock,
  azureModelMock,
  modelMock,
} = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  createOpenAIMock: vi.fn(),
  openAIChatMock: vi.fn(),
  createAnthropicMock: vi.fn(),
  anthropicModelMock: vi.fn(),
  createAzureMock: vi.fn(),
  azureModelMock: vi.fn(),
  modelMock: { modelId: "test-model" },
}));

vi.mock("ai", () => ({ generateText: generateTextMock }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: createOpenAIMock }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: createAnthropicMock }));
vi.mock("@ai-sdk/azure", () => ({ createAzure: createAzureMock }));

// Mock environment variables
const originalEnv = process.env;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
  vi.clearAllMocks();
  generateTextMock.mockResolvedValue({});
  createOpenAIMock.mockReturnValue({ chat: openAIChatMock });
  openAIChatMock.mockReturnValue(modelMock);
  createAnthropicMock.mockReturnValue(anthropicModelMock);
  anthropicModelMock.mockReturnValue(modelMock);
  createAzureMock.mockReturnValue(azureModelMock);
  azureModelMock.mockReturnValue(modelMock);
});

afterEach(() => {
  process.env = originalEnv;
  vi.useRealTimers();
});

describe("getModelChain", () => {
  const hfQwenModel =
    "hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M";

  it("returns the default chain in priority order when MODEL_CHAIN is not set", () => {
    delete process.env.MODEL_CHAIN;
    const chain = getModelChain();
    expect(chain).toEqual([
      {
        provider: "ollama",
        model: "qwen2.5-coder:1.5b",
        fullName: "ollama:qwen2.5-coder:1.5b",
      },
      {
        provider: "openrouter",
        model: "openrouter/free",
        fullName: "openrouter:openrouter/free",
      },
      {
        provider: "ollama",
        model: hfQwenModel,
        fullName: `ollama:${hfQwenModel}`,
      },
    ]);
  });

  it("parses MODEL_CHAIN from env", () => {
    process.env.MODEL_CHAIN = "anthropic:claude-3,openrouter:gpt-4";
    const chain = getModelChain();
    expect(chain).toHaveLength(2);
    expect(chain[0]).toEqual({ provider: "anthropic", model: "claude-3", fullName: "anthropic:claude-3" });
    expect(chain[1]).toEqual({ provider: "openrouter", model: "gpt-4", fullName: "openrouter:gpt-4" });
  });

  it("adds preferred model at front if not in chain", () => {
    process.env.MODEL_CHAIN = "openrouter:gpt-4";
    const chain = getModelChain("claude-sonnet-4");
    expect(chain[0].model).toBe("claude-sonnet-4");
    expect(chain[0].provider).toBe("anthropic");
    expect(chain).toHaveLength(2);
  });

  it("promotes a preferred model already in the chain without duplicating it", () => {
    process.env.MODEL_CHAIN =
      "ollama:qwen2.5-coder:1.5b,openrouter:openrouter/free,ollama:qwen2.5-coder:1.5b";
    const chain = getModelChain("qwen2.5-coder:1.5b");
    expect(chain[0]).toEqual({
      provider: "ollama",
      model: "qwen2.5-coder:1.5b",
      fullName: "ollama:qwen2.5-coder:1.5b",
    });
    expect(chain.filter((entry) => entry.model === "qwen2.5-coder:1.5b")).toHaveLength(1);
  });

  it("parses model names with additional colons after the provider separator", () => {
    process.env.MODEL_CHAIN = `ollama:${hfQwenModel},openrouter:openrouter/free`;
    expect(getModelChain()[0]).toEqual({
      provider: "ollama",
      model: hfQwenModel,
      fullName: `ollama:${hfQwenModel}`,
    });
  });

  it("detects the installed Qwen 1.5B model as Ollama", () => {
    expect(getModelChain("qwen2.5-coder:1.5b")[0]).toMatchObject({
      provider: "ollama",
      model: "qwen2.5-coder:1.5b",
    });
  });

  it("detects and promotes the installed HF Qwen model as Ollama", () => {
    const chain = getModelChain(hfQwenModel);
    expect(chain[0]).toMatchObject({ provider: "ollama", model: hfQwenModel });
    expect(chain.filter((entry) => entry.model === hfQwenModel)).toHaveLength(1);
  });

  it("routes an unknown unqualified preferred model to OpenRouter", () => {
    const chain = getModelChain("unknown-model");
    expect(chain[0]).toMatchObject({
      provider: "openrouter",
      model: "unknown-model",
    });
  });

  it("routes a tagged model name to Ollama instead of OpenRouter", () => {
    expect(getModelChain("unknown-local-model:Q4_K_M")[0]).toMatchObject({
      provider: "ollama",
      model: "unknown-local-model:Q4_K_M",
    });
  });

  it("detects gpt/o1 models for azure", () => {
    const chain = getModelChain("gpt-4o");
    expect(chain[0].provider).toBe("azure");
    const chain2 = getModelChain("o1-preview");
    expect(chain2[0].provider).toBe("azure");
  });
});

describe("hasRequiredEnvVars", () => {
  it("returns true for anthropic with API key", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    expect(hasRequiredEnvVars("anthropic")).toBe(true);
  });

  it("returns false for anthropic without API key", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(hasRequiredEnvVars("anthropic")).toBe(false);
  });

  it("returns true for ollama with base URL", () => {
    process.env.OLLAMA_BASE_URL = "http://localhost:11434/v1";
    expect(hasRequiredEnvVars("ollama")).toBe(true);
  });

  it("returns true for ollama without base URL", () => {
    delete process.env.OLLAMA_BASE_URL;
    expect(hasRequiredEnvVars("ollama")).toBe(true);
  });

  it("returns true for openrouter with API key", () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    expect(hasRequiredEnvVars("openrouter")).toBe(true);
  });

  it("returns false for openrouter without API key", () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(hasRequiredEnvVars("openrouter")).toBe(false);
  });

  it("returns true for azure with all required vars", () => {
    process.env.AZURE_API_KEY = "key";
    process.env.AZURE_BASE_URL = "https://test.openai.azure.com";
    process.env.AZURE_DEPLOYMENT = "gpt-4";
    expect(hasRequiredEnvVars("azure")).toBe(true);
  });

  it("returns false for azure missing any var", () => {
    process.env.AZURE_API_KEY = "key";
    process.env.AZURE_BASE_URL = "https://test.openai.azure.com";
    // Missing AZURE_DEPLOYMENT
    expect(hasRequiredEnvVars("azure")).toBe(false);
  });

  it("returns true for codecraft with either key", () => {
    process.env.CODECRAFT_API_KEY = "key";
    expect(hasRequiredEnvVars("codecraft")).toBe(true);
    delete process.env.CODECRAFT_API_KEY;
    process.env.OPENAI_API_KEY = "key";
    expect(hasRequiredEnvVars("codecraft")).toBe(true);
  });

  it("returns false for codecraft without any key", () => {
    delete process.env.CODECRAFT_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(hasRequiredEnvVars("codecraft")).toBe(false);
  });

  it("returns false for unknown provider", () => {
    expect(hasRequiredEnvVars("unknown")).toBe(false);
  });
});

describe("createModelForEntry", () => {
  it("throws for unknown provider", () => {
    expect(() => createModelForEntry({ provider: "unknown", model: "test", fullName: "unknown:test" })).toThrow("Unknown provider: unknown");
  });

  it("connects Ollama models through the local OpenAI-compatible endpoint", () => {
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_BASE_URL;
    const model = createModelForEntry({
      provider: "ollama",
      model: "qwen2.5-coder:1.5b",
      fullName: "ollama:qwen2.5-coder:1.5b",
    });

    expect(createOpenAIMock).toHaveBeenCalledWith({
      apiKey: "ollama",
      baseURL: "http://localhost:11434/v1",
    });
    expect(openAIChatMock).toHaveBeenCalledWith("qwen2.5-coder:1.5b");
    expect(model).toBe(modelMock);
  });

  it("preserves Anthropic, OpenRouter, Azure, KIE, and CodeCraft model creation", () => {
    process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
    process.env.OPENROUTER_API_KEY = "openrouter-test-key";
    process.env.AZURE_API_KEY = "azure-test-key";
    process.env.AZURE_BASE_URL = "https://azure.example.test";
    process.env.AZURE_DEPLOYMENT = "test-deployment";
    process.env.KIE_API_KEY = "kie-test-key";
    process.env.CODECRAFT_API_KEY = "codecraft-test-key";

    createModelForEntry({ provider: "anthropic", model: "claude-test", fullName: "anthropic:claude-test" });
    expect(createAnthropicMock).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "anthropic-test-key",
      baseURL: "https://api.anthropic.com/v1",
    }));

    createModelForEntry({ provider: "openrouter", model: "openrouter/free", fullName: "openrouter:openrouter/free" });
    expect(createOpenAIMock).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "openrouter-test-key",
      baseURL: "https://openrouter.ai/api/v1",
    }));

    createModelForEntry({ provider: "azure", model: "gpt-test", fullName: "azure:gpt-test" });
    expect(createAzureMock).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "azure-test-key",
      baseURL: "https://azure.example.test",
      resourceName: "test-deployment",
    }));

    createModelForEntry({ provider: "kie", model: "claude-test", fullName: "kie:claude-test" });
    createModelForEntry({ provider: "codecraft", model: "gpt-test", fullName: "codecraft:gpt-test" });
    expect(createOpenAIMock).toHaveBeenCalledTimes(3);
  });
});

describe("selectWorkingModel", () => {
  it("skips models that produced truncated output and selects the next configured model", async () => {
    const first = "ollama:qwen2.5-coder:1.5b";
    const fallback = "ollama:hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M";
    process.env.MODEL_CHAIN = `${first},openrouter:openrouter/free,${fallback}`;
    delete process.env.OPENROUTER_API_KEY;

    const result = await selectWorkingModel("qwen2.5-coder:1.5b", {
      excludedModels: [first],
    });

    expect(result.entry.fullName).toBe(fallback);
    expect(result.attempts).toBe(1);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("skips a provider missing its connection requirements", async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.MODEL_CHAIN =
      "openrouter:openrouter/free,ollama:qwen2.5-coder:1.5b";

    const result = await selectWorkingModel("qwen2.5-coder:1.5b");

    expect(result.entry).toMatchObject({
      provider: "ollama",
      model: "qwen2.5-coder:1.5b",
    });
    expect(result.attempts).toBe(1);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("continues to the next model after a ping failure without logging API keys", async () => {
    process.env.OLLAMA_API_KEY = "ollama-test-key-secret";
    process.env.MODEL_CHAIN =
      "ollama:unavailable-local-model,ollama:qwen2.5-coder:1.5b";
    vi.useFakeTimers();
    generateTextMock
      .mockRejectedValueOnce(
        new Error(`Authorization: Bearer ${process.env.OLLAMA_API_KEY}`),
      )
      .mockResolvedValueOnce({});
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await selectWorkingModel("unavailable-local-model");

    expect(result.entry.model).toBe("qwen2.5-coder:1.5b");
    expect(result.attempts).toBe(2);
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(warning.mock.calls.flat().join(" ")).not.toContain(
      "ollama-test-key-secret",
    );
  });

  it("aborts and clears the timeout when a model ping times out", async () => {
    process.env.MODEL_CHAIN = "ollama:qwen2.5-coder:1.5b";
    vi.useFakeTimers();
    let pingSignal: AbortSignal | undefined;
    generateTextMock.mockImplementation(
      ({ abortSignal }: { abortSignal: AbortSignal }) => {
        pingSignal = abortSignal;
        return new Promise((_, reject) => {
          abortSignal.addEventListener(
            "abort",
            () => reject(abortSignal.reason),
            { once: true },
          );
        });
      },
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const selection = expect(
      selectWorkingModel("qwen2.5-coder:1.5b", { pingTimeoutMs: 50 }),
    ).rejects.toThrow(/No working model is available/i);
    await vi.advanceTimersByTimeAsync(50);

    await selection;
    expect(pingSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Ping timeout"),
    );
  });

  it("uses the configurable Ollama ping timeout for slow local model startup", async () => {
    process.env.MODEL_CHAIN = "ollama:qwen2.5-coder:1.5b";
    process.env.OLLAMA_PING_TIMEOUT_MS = "60000";
    vi.useFakeTimers();
    generateTextMock.mockImplementation(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_, reject) => {
          abortSignal.addEventListener(
            "abort",
            () => reject(abortSignal.reason),
            { once: true },
          );
        }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const selection = expect(
      selectWorkingModel("qwen2.5-coder:1.5b"),
    ).rejects.toThrow(/No working model is available/i);
    await vi.advanceTimersByTimeAsync(59999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await selection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects invalid Ollama ping timeout configuration", async () => {
    process.env.MODEL_CHAIN = "ollama:qwen2.5-coder:1.5b";
    process.env.OLLAMA_PING_TIMEOUT_MS = "not-a-timeout";

    await expect(
      selectWorkingModel("qwen2.5-coder:1.5b"),
    ).rejects.toMatchObject({
      name: "ModelRouterError",
      code: "AI_NOT_CONFIGURED",
      message:
        "OLLAMA_PING_TIMEOUT_MS must be a positive integer number of milliseconds.",
    });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("throws when all providers are missing required configuration", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OLLAMA_BASE_URL;

    process.env.MODEL_CHAIN =
      "anthropic:claude-3,openrouter:gpt-4";

    await expect(
      selectWorkingModel("test", { pingTimeoutMs: 100 }),
    ).rejects.toMatchObject({
      code: "MODEL_SELECTION_FAILED",
      stage: "model_selection",
      failures: [
        {
          provider: "openrouter",
          model: "test",
          reason: "required configuration is missing",
        },
        {
          provider: "anthropic",
          model: "claude-3",
          reason: "required configuration is missing",
        },
        {
          provider: "openrouter",
          model: "gpt-4",
          reason: "required configuration is missing",
        },
      ],
    });
  });

  it("reports safe provider, model, timeout, and HTTP failure details", async () => {
    process.env.MODEL_CHAIN =
      "ollama:qwen2.5-coder:1.5b,ollama:hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M";
    const secret = "ollama-test-key-secret";
    process.env.OLLAMA_API_KEY = secret;
    generateTextMock
      .mockRejectedValueOnce(new Error("Ping timeout"))
      .mockRejectedValueOnce(
        Object.assign(new Error(`Authorization: Bearer ${secret}`), {
          statusCode: 503,
        }),
      );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    let selectionError: unknown;
    try {
      await selectWorkingModel("qwen2.5-coder:1.5b");
    } catch (error) {
      selectionError = error;
    }

    expect(selectionError).toMatchObject({
      code: "MODEL_SELECTION_FAILED",
      stage: "model_selection",
      failures: [
        {
          provider: "ollama",
          model: "qwen2.5-coder:1.5b",
          reason: "ping timed out",
        },
        {
          provider: "ollama",
          model: "hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M",
          reason: "provider request failed",
          status: 503,
        },
      ],
    });
    expect(
      (selectionError as { publicMessage: string }).publicMessage,
    ).not.toContain(secret);
    expect(warning.mock.calls.flat().join(" ")).not.toContain(secret);
  });

  it("throws when MODEL_CHAIN contains no models", async () => {
    process.env.MODEL_CHAIN = ",,,";

    await expect(
      selectWorkingModel("", { pingTimeoutMs: 100 }),
    ).rejects.toThrow(/No models are configured/i);
  });
});

describe("Ollama AI provider configuration", () => {
  it("uses the installed Qwen models for its default and fallback", () => {
    process.env.AI_PROVIDER = "ollama";
    delete process.env.OLLAMA_DEFAULT_MODEL;

    expect(getAIConfig()).toMatchObject({
      provider: "ollama",
      baseURL: "http://localhost:11434/v1",
      defaultModel: "qwen2.5-coder:1.5b",
      fallbackModels: [
        "hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M",
      ],
    });
  });
});