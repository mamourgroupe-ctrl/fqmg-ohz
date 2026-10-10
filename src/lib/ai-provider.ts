/**
 * AI Provider Abstraction Layer
 * 
 * Allows switching between AI providers without touching main code.
 * Control via AI_PROVIDER env var in .env.local:
 *   AI_PROVIDER=codecraft (default) | openrouter | openai | custom
 */

export type AIProviderName = "codecraft" | "openrouter" | "openai" | "orcarouter" | "custom";

export interface AIConfig {
  provider: AIProviderName;
  apiKey: string | undefined;
  baseURL: string;
  defaultModel: string;
  fallbackModels?: string[];
}

const PROVIDER_CONFIGS: Record<
  AIProviderName,
  (env: NodeJS.ProcessEnv) => AIConfig
> = {
  codecraft: (env) => ({
    provider: "codecraft",
    apiKey: env.CODECRAFT_API_KEY || env.OPENAI_API_KEY,
    baseURL: env.CODECRAFT_BASE_URL || "https://codecraftapi.com/v1",
    defaultModel: env.CODECRAFT_DEFAULT_MODEL || "claude-sonnet-5",
    fallbackModels: ["gpt-5.5", "gpt-5.6-luna", "deepseek-v4-pro-max"],
  }),

  openrouter: (env) => ({
    provider: "openrouter",
    apiKey: env.OPENROUTER_API_KEY,
    baseURL: env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    defaultModel:
      env.OPENROUTER_DEFAULT_MODEL || "anthropic/claude-3.5-sonnet",
    fallbackModels: [
      "meta-llama/llama-3.3-70b-instruct:free",
      "google/gemini-2.0-flash-exp:free",
      "deepseek/deepseek-chat",
    ],
  }),

  openai: (env) => ({
    provider: "openai",
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    defaultModel: env.OPENAI_DEFAULT_MODEL || "gpt-4o-mini",
    fallbackModels: ["gpt-4o", "gpt-3.5-turbo"],
  }),

  orcarouter: (env) => ({
    provider: "orcarouter",
    apiKey: env.ORCAROUTER_API_KEY,
    baseURL: env.ORCAROUTER_BASE_URL || "https://api.orcarouter.ai/v1",
    defaultModel:
      env.ORCAROUTER_DEFAULT_MODEL || "anthropic/claude-sonnet-4.6",
    fallbackModels: [
      "orcarouter/auto",
      "openai/gpt-5.5",
      "google/gemini-3.5-flash",
      "deepseek/deepseek-v4-pro",
    ],
  }),

  custom: (env) => ({
    provider: "custom",
    apiKey: env.CUSTOM_API_KEY,
    baseURL: env.CUSTOM_BASE_URL || "https://api.openai.com/v1",
    defaultModel: env.CUSTOM_DEFAULT_MODEL || "gpt-4o-mini",
  }),
};

export function getAIConfig(): AIConfig {
  const providerName = (process.env.AI_PROVIDER ||
    "codecraft") as AIProviderName;
  const configFn = PROVIDER_CONFIGS[providerName];

  if (!configFn) {
    console.warn(
      `[ai-provider] Unknown provider "${providerName}". Falling back to codecraft.`,
    );
    return PROVIDER_CONFIGS.codecraft(process.env);
  }

  const config = configFn(process.env);

  if (!config.apiKey) {
    console.warn(
      `[ai-provider] Provider "${providerName}" has no API key configured. Check .env.local`,
    );
  }

  return config;
}

export function getProviderDisplayName(): string {
  const config = getAIConfig();
  const names: Record<AIProviderName, string> = {
    codecraft: "CodeCraft",
    openrouter: "OpenRouter",
    openai: "OpenAI",
    orcarouter: "OrcaRouter",
    custom: "Custom",
  };
  return names[config.provider];
}
