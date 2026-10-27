import { BudgetLedger } from "@/agent/budget";
import { loadAgentConfig, type AgentConfig } from "@/agent/config";
import { AgentJobStore } from "@/agent/job-store";
import { loadPriceBook, type PriceBook } from "@/agent/pricing";
import { createDisabledMotionRepairProvider, createGenerateObjectRepairProvider, type MotionRepairProvider } from "@/agent/repair-provider";
import type { RenderBackend } from "@/agent/render-contract";
import { createDisabledVisionProvider, createOpenAiCompatibleVisionProvider } from "@/agent/vision-providers";
import type { VisionProvider } from "@/agent/vision-critique";
import { createModelForEntry, getModelChain, hasRequiredEnvVars } from "@/lib/model-router";
import { RemotionLambdaRenderBackend } from "@/render/lambda/lambda-render-backend";
import { RemotionLocalRenderBackend } from "@/render/remotion/local-render-backend";

/**
 * Process-wide wiring for the agent loop.
 *
 * Defaults are deliberately inert: the vision provider is disabled, the repair provider is
 * disabled, and the price book is empty, so no paid request can start until an operator sets
 * AGENT_VISION_ENABLED / AGENT_REPAIR_ENABLED with verified prices. Every credential is read
 * from the environment at this point only; nothing is logged.
 */

export interface AgentRuntime {
  config: AgentConfig;
  priceBook: PriceBook;
  budget: BudgetLedger;
  visionProvider: VisionProvider;
  repairProvider: MotionRepairProvider;
  store: AgentJobStore;
  getRenderBackend(engine: "remotion-local" | "remotion-lambda"): RenderBackend;
}

interface AgentRuntimeGlobal {
  __fqmgAgentRuntime?: AgentRuntime;
}

function getLocalBackend(): RenderBackend {
  // The loop supplies the scale per request (default: a half-scale preview render).
  return new RemotionLocalRenderBackend();
}

function getLambdaBackend(): RenderBackend {
  return new RemotionLambdaRenderBackend({
    region: process.env.REMOTION_REGION ?? "us-east-1",
    serveUrl: process.env.REMOTION_SERVE_URL ?? "",
    functionName: process.env.REMOTION_FUNCTION_NAME ?? "",
  });
}

function buildVisionProvider(config: AgentConfig, env: Environment): VisionProvider {
  if (!config.visionEnabled || config.visionProviderId === "disabled") {
    return createDisabledVisionProvider(config.visionModelId);
  }

  const imageSupportVerifiedByOperator = env.AGENT_VISION_IMAGE_SUPPORT_VERIFIED === "1";
  if (!imageSupportVerifiedByOperator) {
    // Fail closed: never assume a model accepts images.
    return createDisabledVisionProvider(config.visionModelId);
  }

  return createOpenAiCompatibleVisionProvider({
    id: config.visionProviderId,
    modelId: config.visionModelId,
    apiKey: env.AGENT_VISION_API_KEY,
    baseUrl: env.AGENT_VISION_BASE_URL ?? "",
    imageSupportVerifiedByOperator: true,
    requestJsonResponseFormat: env.AGENT_VISION_JSON_MODE === "1",
  });
}

/**
 * The repair provider reuses the existing model router, which resolves credentials from
 * `process.env`; that is why only the vision path is fully injectable here.
 */
function buildRepairProvider(config: AgentConfig): MotionRepairProvider {
  if (!config.repairEnabled) return createDisabledMotionRepairProvider(config.repairModelId);

  const chain = getModelChain(config.repairModelId);
  const entry = chain[0];
  if (!entry) return createDisabledMotionRepairProvider(config.repairModelId);
  // A client can be constructed without credentials, so the credential check is explicit: without
  // it a disabled-by-default deployment could still dispatch a paid repair request.
  if (!hasRequiredEnvVars(entry.provider)) {
    return createDisabledMotionRepairProvider(config.repairModelId);
  }

  try {
    return createGenerateObjectRepairProvider({
      id: `model-router:${entry.provider}`,
      modelId: entry.model,
      model: createModelForEntry(entry),
    });
  } catch {
    return createDisabledMotionRepairProvider(config.repairModelId);
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

/** Builds a runtime from an explicit environment so tests never depend on process.env. */
export function createAgentRuntime(env: Environment = process.env): AgentRuntime {
  const config = loadAgentConfig(env);
  const priceBook = loadPriceBook(env);
  const budget = new BudgetLedger({
    policy: {
      dailyLimitUsd: config.dailyBudgetUsd,
      taskLimitUsd: config.taskBudgetUsd,
      userDailyLimitUsd: config.userDailyBudgetUsd,
    },
  });

  return {
    config,
    priceBook,
    budget,
    visionProvider: buildVisionProvider(config, env),
    repairProvider: buildRepairProvider(config),
    store: new AgentJobStore({ ttlMs: config.jobTtlMs }),
    getRenderBackend: (engine) =>
      engine === "remotion-lambda" ? getLambdaBackend() : getLocalBackend(),
  };
}

export function getAgentRuntime(): AgentRuntime {
  const globalRuntime = globalThis as typeof globalThis & AgentRuntimeGlobal;
  globalRuntime.__fqmgAgentRuntime ??= createAgentRuntime();
  return globalRuntime.__fqmgAgentRuntime;
}
