/**
 * Model Router — selects the first working model from a priority chain.
 *
 * Reads MODEL_CHAIN from env (comma-separated "provider:model" pairs).
 * Pings each model in order with a minimal prompt; returns the first that responds.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { generateText, type LanguageModel } from "ai";

export class ModelRouterError extends Error {
  constructor(
    message: string,
    public readonly code: "AI_NOT_CONFIGURED" | "AI_UNAVAILABLE",
  ) {
    super(message);
    this.name = "ModelRouterError";
  }
}

export interface ModelEntry {
  provider: string;
  model: string;
  fullName: string;
}

function getDefaultChain(): string {
  return "ollama:qwen2.5-coder:7b,openrouter:openrouter/free,ollama:qwen2.5-coder:1.5b";
}

export function getModelChain(preferredModel?: string): ModelEntry[] {
  const chain = process.env.MODEL_CHAIN?.trim() || getDefaultChain();

  const entries: ModelEntry[] = chain
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const colonIdx = item.indexOf(":");
      if (colonIdx === -1) {
        return { provider: item, model: item, fullName: item };
      }
      const provider = item.slice(0, colonIdx).trim();
      const model = item.slice(colonIdx + 1).trim();
      return { provider, model, fullName: item };
    });

  if (preferredModel && preferredModel.length > 0) {
    const exists = entries.some((e) => e.model === preferredModel);
    if (!exists) {
      let provider = "openrouter";
      if (preferredModel.startsWith("claude-")) provider = "anthropic";
      else if (preferredModel.startsWith("qwen2.5-coder")) provider = "ollama";
      else if (preferredModel.startsWith("gpt-") || preferredModel.startsWith("o1")) provider = "azure";
      entries.unshift({
        provider,
        model: preferredModel,
        fullName: `${provider}:${preferredModel}`,
      });
    }
  }

  return entries;
}

// Check if required env vars are present for a provider
export function hasRequiredEnvVars(provider: string): boolean {
  switch (provider) {
    case "anthropic":
      return !!process.env.ANTHROPIC_API_KEY;
    case "ollama":
      // Ollama doesn't strictly need API key, but needs base URL
      return !!process.env.OLLAMA_BASE_URL;
    case "openrouter":
      return !!process.env.OPENROUTER_API_KEY;
    case "azure":
      return !!(process.env.AZURE_API_KEY && process.env.AZURE_BASE_URL && process.env.AZURE_DEPLOYMENT);
    case "kie":
      return !!process.env.KIE_API_KEY;
    case "codecraft":
      return !!(process.env.CODECRAFT_API_KEY || process.env.OPENAI_API_KEY);
    default:
      return false;
  }
}

export function createModelForEntry(entry: ModelEntry): LanguageModel {
  const { provider, model } = entry;

  if (provider === "anthropic") {
    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: "https://api.anthropic.com/v1",
    });
    return anthropic(model);
  }

  if (provider === "ollama") {
    const openai = createOpenAI({
      apiKey: process.env.OLLAMA_API_KEY || "ollama",
      baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
    });
    return openai.chat(model);
  }

  if (provider === "openrouter") {
    const openai = createOpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    });
    return openai.chat(model);
  }

  if (provider === "azure") {
    const azure = createAzure({
      apiKey: process.env.AZURE_API_KEY,
      baseURL: process.env.AZURE_BASE_URL,
      resourceName: process.env.AZURE_DEPLOYMENT,
      apiVersion: process.env.AZURE_API_VERSION || "2024-08-01-preview",
    });
    return azure(model);
  }

  if (provider === "kie") {
    const openai = createOpenAI({
      apiKey: process.env.KIE_API_KEY,
      baseURL: process.env.KIE_BASE_URL || "https://api.kie.ai/claude/v1",
    });
    return openai.chat(model);
  }

  if (provider === "codecraft") {
    const openai = createOpenAI({
      apiKey: process.env.CODECRAFT_API_KEY || process.env.OPENAI_API_KEY,
      baseURL: process.env.CODECRAFT_BASE_URL || "https://codecraftapi.com/v1",
    });
    return openai.chat(model);
  }

  throw new Error(`Unknown provider: ${provider}`);
}

export async function selectWorkingModel(
  preferredModel: string,
  options: { pingTimeoutMs?: number } = {}
): Promise<{ model: LanguageModel; entry: ModelEntry; attempts: number }> {
  const chain = getModelChain(preferredModel);
  const pingTimeout = options.pingTimeoutMs ?? 30000;
  let attempts = 0;

  for (const entry of chain) {
    // Skip providers with missing env vars before attempting
    if (!hasRequiredEnvVars(entry.provider)) {
      console.warn(`[Router] ⏭️  Skipping ${entry.fullName} — missing required env vars`);
      continue;
    }

    attempts++;
    console.log(`[Router] Trying ${entry.fullName} (attempt ${attempts})...`);

    const startTime = Date.now();

    try {
      const model = createModelForEntry(entry);

      await generateText({
        model,
        prompt: "Reply with exactly: OK",
        maxOutputTokens: 10,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(pingTimeout),
      });

      const pingTimeMs = Date.now() - startTime;
      console.log(`[Router] ✅ Selected ${entry.fullName} (ping: ${pingTimeMs}ms)`);
      return { model, entry, attempts };
    } catch (err) {
      const pingTimeMs = Date.now() - startTime;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Router] ❌ ${entry.fullName} failed after ${pingTimeMs}ms: ${msg}`);
      continue;
    }
  }

  if (attempts === 0) {
    throw new ModelRouterError(
      "No AI provider is configured for the selected model chain. For Qwen via Ollama, run Ollama with the selected model and set OLLAMA_BASE_URL in .env.local to its server URL ending in /v1. For OpenRouter, set OPENROUTER_API_KEY. Use MODEL_CHAIN to configure other providers. Restart the server after changing settings. An OpenAI key is not required for Ollama.",
      "AI_NOT_CONFIGURED",
    );
  }

  throw new ModelRouterError(
    "None of the configured AI models could be reached successfully. Check the provider URL, credentials, model availability and network access, then try again.",
    "AI_UNAVAILABLE",
  );
}
