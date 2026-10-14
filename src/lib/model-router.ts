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

export interface ModelFailureDiagnostic {
  provider: string;
  model: string;
  reason: string;
  status?: number;
}

export class ModelRouterError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ModelRouterError";
    this.code = code;
  }
}

export class ModelSelectionError extends ModelRouterError {
  readonly code = "MODEL_SELECTION_FAILED";
  readonly stage = "model_selection";
  readonly failures: ModelFailureDiagnostic[];
  readonly publicMessage: string;

  constructor(
    configuredModels: number,
    attempts: number,
    failures: ModelFailureDiagnostic[],
  ) {
    const details = failures
      .map(
        ({ provider, model, reason, status }) =>
          `${provider}:${model} — ${reason}${status ? ` (HTTP ${status})` : ""}`,
      )
      .join("; ");
    const publicMessage =
      `No working model is available during model selection. Checked ${configuredModels} configured model(s); ${attempts} attempt(s) were made.` +
      (details ? ` ${details}` : "") +
      " Verify provider configuration, model availability, and local service responsiveness.";

    super(publicMessage, "MODEL_SELECTION_FAILED");
    this.name = "ModelSelectionError";
    this.failures = failures;
    this.publicMessage = publicMessage;
  }
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

function getFailureDiagnostic(
  entry: ModelEntry,
  error: unknown,
): ModelFailureDiagnostic {
  const record =
    error !== null && typeof error === "object"
      ? (error as Record<string, unknown>)
      : undefined;
  const rawStatus = record?.statusCode ?? record?.status;
  const status = typeof rawStatus === "number" ? rawStatus : undefined;
  const message = error instanceof Error ? error.message : "";
  let reason = "provider request failed";

  if (status !== undefined) {
    reason = "provider request failed";
  } else if (/model .+ not found|model not found/i.test(message)) {
    reason = "model not found";
  } else if (/timeout|timed out/i.test(message)) {
    reason = "ping timed out";
  }

  return {
    provider: entry.provider,
    model: entry.model,
    reason,
    ...(status === undefined ? {} : { status }),
  };
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
  options: {
    pingTimeoutMs?: number;
    excludedModels?: string[];
  } = {},
): Promise<{ model: LanguageModel; entry: ModelEntry; attempts: number }> {
  const chain = getModelChain(preferredModel);
  const pingTimeout = options.pingTimeoutMs ?? 30000;
  const excludedModels = new Set(options.excludedModels ?? []);
  let attempts = 0;
  const failures: ModelFailureDiagnostic[] = [];

  for (const entry of chain) {
    if (excludedModels.has(entry.fullName)) continue;

    // Skip providers with missing env vars before attempting
    if (!hasRequiredEnvVars(entry.provider)) {
      console.warn(`[Router] ⏭️  Skipping ${entry.fullName} — missing required env vars`);
      failures.push({
        provider: entry.provider,
        model: entry.model,
        reason: "required configuration is missing",
      });
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
      failures.push(getFailureDiagnostic(entry, err));
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

  throw new ModelSelectionError(chain.length, attempts, failures);
}