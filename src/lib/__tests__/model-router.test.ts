import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getModelChain, createModelForEntry, selectWorkingModel, hasRequiredEnvVars } from "../model-router";

// Mock environment variables
const originalEnv = process.env;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = originalEnv;
});

describe("getModelChain", () => {
  it("returns default chain when MODEL_CHAIN not set", () => {
    delete process.env.MODEL_CHAIN;
    const chain = getModelChain();
    expect(chain.length).toBeGreaterThan(0);
    expect(chain[0].provider).toBe("ollama");
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
  });

  it("does not duplicate preferred model if already in chain", () => {
    process.env.MODEL_CHAIN = "anthropic:claude-sonnet-4,openrouter:gpt-4";
    const chain = getModelChain("claude-sonnet-4");
    expect(chain.filter(e => e.model === "claude-sonnet-4")).toHaveLength(1);
  });

  it("detects qwen models for ollama", () => {
    const chain = getModelChain("qwen2.5-coder:7b");
    expect(chain[0].provider).toBe("ollama");
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

  it("returns false for ollama without base URL", () => {
    delete process.env.OLLAMA_BASE_URL;
    expect(hasRequiredEnvVars("ollama")).toBe(false);
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
});

describe("selectWorkingModel", () => {
  it("skips providers with missing env vars", async () => {
    // No env vars set - all should be skipped
    process.env.MODEL_CHAIN = "anthropic:claude-3,openrouter:gpt-4,ollama:qwen";
    // Should not throw even though all fail
    // Since all providers lack env vars, they'll all be skipped and fall back to last
    const result = await selectWorkingModel("test", { pingTimeoutMs: 100 });
    // Should return something (the fallback)
    expect(result).toBeDefined();
    expect(result.model).toBeDefined();
    expect(result.entry).toBeDefined();
    expect(typeof result.attempts).toBe("number");
  });
});