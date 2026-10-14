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

export interface ModelEntry {
  provider: string;
  model: string;
  fullName: string;
}

function getDefaultChain(): string {
  return "ollama:qwen2.5-coder:1.5b,openrouter:openrouter/free,ollama:hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M";
}

function inferProvider(model: string): string | undefined {
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("qwen2.5-coder:") || model.startsWith("hf.co/")) {
    return "ollama";
  }
  if (model.startsWith("gpt-") || model.startsWith("o1")) return "azure";
  if (model.includes("/")) return "openrouter";
  if (model.includes(":")) return "ollama";
  return undefined;
}

function getSafeFailureMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : "Unknown error";
  const secrets = Object.entries(process.env)
    .filter(([name, value]) => value && /(API_KEY|TOKEN|SECRET)/i.test(name))
    .map(([, value]) => value!)
    .sort((left, right) => right.length - left.length);

  for (const secret of secrets) {
    message = message.split(secret).join("[REDACTED]");
  }

  return message
    .replace(/(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret)[=:]\s*)[^\s&,;]+/gi, "$1[REDACTED]")
    .replace(/\bsk-(?:or-)?[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .slice(0, 500);
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

  if (preferredModel) {
    const matchingEntries = entries.filter((entry) => entry.model === preferredModel);
    const inferredProvider = inferProvider(preferredModel);
    const existingEntry = matchingEntries[0];
    const preferredEntry = existingEntry
      ? inferredProvider && existingEntry.provider !== inferredProvider
        ? {
            provider: inferredProvider,
            model: preferredModel,
            fullName: `${inferredProvider}:${preferredModel}`,
          }
        : existingEntry
      : {
          provider: inferredProvider ?? "openrouter",
          model: preferredModel,
          fullName: `${inferredProvider ?? "openrouter"}:${preferredModel}`,
        };

    return [
      preferredEntry,
      ...entries.filter((entry) => entry.model !== preferredModel),
    ];
  }

  return entries;
}

// Check if required env vars are present for a provider
export function hasRequiredEnvVars(provider: string): boolean {
  switch (provider) {
    case "anthropic":
      return !!process.env.ANTHROPIC_API_KEY;
    case "ollama":
      // Ollama can use the default local endpoint.
      return true;
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
    const abortController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const model = createModelForEntry(entry);

      await Promise.race([
        generateText({
          model,
          prompt: "Reply with exactly: OK",
          maxOutputTokens: 10,
          abortSignal: abortController.signal,
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            const error = new Error("Ping timeout");
            abortController.abort(error);
            reject(error);
          }, pingTimeout);
        }),
      ]);

      const pingTimeMs = Date.now() - startTime;
      console.log(`[Router] ✅ Selected ${entry.fullName} (ping: ${pingTimeMs}ms)`);
      return { model, entry, attempts };
    } catch (err) {
      const pingTimeMs = Date.now() - startTime;
      const msg = getSafeFailureMessage(err);
      console.warn(`[Router] ❌ ${entry.fullName} failed after ${pingTimeMs}ms: ${msg}`);
      continue;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  if (chain.length === 0) {
    throw new Error(
      "No models are configured. Check the MODEL_CHAIN environment variable.",
    );
  }

  throw new Error(
    `No working model is available. Checked ${chain.length} configured model(s); ${attempts} attempt(s) were made. Verify provider credentials, endpoints, and model names.`,
  );
}