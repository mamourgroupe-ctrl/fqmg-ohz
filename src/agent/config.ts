import { z } from "zod";

/**
 * Agent configuration. Every value is read from the environment, validated, and bounded.
 * An invalid value fails closed with a named variable (never with the value itself, so
 * nothing secret can be echoed back into logs or HTTP responses).
 */

export class AgentConfigError extends Error {
  constructor(readonly variable: string, reason: string) {
    super(
      `Agent configuration variable ${variable} is invalid (${reason}). Fix it in .env.local or remove it to use the default.`,
    );
    this.name = "AgentConfigError";
  }
}

const Bound = (min: number, max: number, kind: "int" | "float" = "int") =>
  kind === "int"
    ? z.number().int().min(min).max(max)
    : z.number().finite().min(min).max(max);

export const AgentConfigSchema = z.object({
  /** Hard upper bound on render + critique iterations. */
  maxIterations: Bound(1, 4),
  frameCount: Bound(1, 8),
  frameWidth: Bound(128, 1280),
  minFrameSpacingSeconds: Bound(0.01, 1, "float"),

  renderTimeoutMs: Bound(10_000, 900_000),
  probeTimeoutMs: Bound(1_000, 120_000),
  frameTimeoutMs: Bound(1_000, 120_000),
  critiqueTimeoutMs: Bound(1_000, 180_000),
  repairTimeoutMs: Bound(1_000, 300_000),
  artifactDownloadTimeoutMs: Bound(1_000, 300_000),

  maxFrameBytes: Bound(16 * 1024, 8 * 1024 * 1024),
  maxTotalFrameBytes: Bound(64 * 1024, 48 * 1024 * 1024),
  maxArtifactBytes: Bound(1_048_576, 512 * 1024 * 1024),

  /** USD. Owner policy: USD 0.03 per task, USD 0.25 per day. */
  taskBudgetUsd: Bound(0.000001, 100, "float"),
  dailyBudgetUsd: Bound(0.000001, 10_000, "float"),
  /** Output-token ceiling for the vision critique request. */
  critiqueMaxOutputTokens: Bound(64, 4_000),
  /** Output-token ceiling for an AI repair request. */
  repairMaxOutputTokens: Bound(256, 32_000),

  /** Paid providers are off unless explicitly enabled. */
  visionEnabled: z.boolean(),
  repairEnabled: z.boolean(),
  visionProviderId: z.enum(["openai-compatible", "disabled"]),
  visionModelId: z.string().min(1).max(160),
  repairModelId: z.string().min(1).max(160),

  keepFrames: z.boolean(),
  jobTtlMs: Bound(60_000, 24 * 60 * 60 * 1000),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const AGENT_CONFIG_DEFAULTS: AgentConfig = {
  maxIterations: 2,
  frameCount: 4,
  frameWidth: 512,
  minFrameSpacingSeconds: 0.04,

  renderTimeoutMs: 180_000,
  probeTimeoutMs: 20_000,
  frameTimeoutMs: 20_000,
  critiqueTimeoutMs: 45_000,
  repairTimeoutMs: 90_000,
  artifactDownloadTimeoutMs: 120_000,

  maxFrameBytes: 2 * 1024 * 1024,
  maxTotalFrameBytes: 12 * 1024 * 1024,
  maxArtifactBytes: 64 * 1024 * 1024,

  taskBudgetUsd: 0.03,
  dailyBudgetUsd: 0.25,
  critiqueMaxOutputTokens: 600,
  repairMaxOutputTokens: 16_000,

  visionEnabled: false,
  repairEnabled: false,
  visionProviderId: "disabled",
  visionModelId: "unconfigured",
  repairModelId: "unconfigured",

  keepFrames: false,
  jobTtlMs: 30 * 60 * 1000,
};

type Environment = Readonly<Record<string, string | undefined>>;

function readBoolean(env: Environment, variable: string, fallback: boolean): boolean {
  const raw = env[variable]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  throw new AgentConfigError(variable, "expected a boolean such as 1/0 or true/false");
}

function readNumber(
  env: Environment,
  variable: string,
  fallback: number,
  kind: "int" | "float",
): number {
  const raw = env[variable]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const pattern = kind === "int" ? /^-?\d+$/ : /^-?\d+(?:\.\d+)?(?:e-?\d+)?$/i;
  if (!pattern.test(raw)) {
    throw new AgentConfigError(variable, `expected a ${kind === "int" ? "whole number" : "number"}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new AgentConfigError(variable, "expected a finite number");
  }
  return value;
}

function readString(env: Environment, variable: string, fallback: string): string {
  const raw = env[variable]?.trim();
  return raw === undefined || raw === "" ? fallback : raw;
}

export function loadAgentConfig(env: Environment = process.env): AgentConfig {
  const defaults = AGENT_CONFIG_DEFAULTS;
  const candidate = {
    maxIterations: readNumber(env, "AGENT_MAX_ITERATIONS", defaults.maxIterations, "int"),
    frameCount: readNumber(env, "AGENT_FRAME_COUNT", defaults.frameCount, "int"),
    frameWidth: readNumber(env, "AGENT_FRAME_WIDTH", defaults.frameWidth, "int"),
    minFrameSpacingSeconds: readNumber(
      env,
      "AGENT_MIN_FRAME_SPACING_SECONDS",
      defaults.minFrameSpacingSeconds,
      "float",
    ),

    renderTimeoutMs: readNumber(env, "AGENT_RENDER_TIMEOUT_MS", defaults.renderTimeoutMs, "int"),
    probeTimeoutMs: readNumber(env, "AGENT_PROBE_TIMEOUT_MS", defaults.probeTimeoutMs, "int"),
    frameTimeoutMs: readNumber(env, "AGENT_FRAME_TIMEOUT_MS", defaults.frameTimeoutMs, "int"),
    critiqueTimeoutMs: readNumber(
      env,
      "AGENT_CRITIQUE_TIMEOUT_MS",
      defaults.critiqueTimeoutMs,
      "int",
    ),
    repairTimeoutMs: readNumber(env, "AGENT_REPAIR_TIMEOUT_MS", defaults.repairTimeoutMs, "int"),
    artifactDownloadTimeoutMs: readNumber(
      env,
      "AGENT_ARTIFACT_DOWNLOAD_TIMEOUT_MS",
      defaults.artifactDownloadTimeoutMs,
      "int",
    ),

    maxFrameBytes: readNumber(env, "AGENT_MAX_FRAME_BYTES", defaults.maxFrameBytes, "int"),
    maxTotalFrameBytes: readNumber(
      env,
      "AGENT_MAX_TOTAL_FRAME_BYTES",
      defaults.maxTotalFrameBytes,
      "int",
    ),
    maxArtifactBytes: readNumber(env, "AGENT_MAX_ARTIFACT_BYTES", defaults.maxArtifactBytes, "int"),

    taskBudgetUsd: readNumber(env, "AGENT_TASK_BUDGET_USD", defaults.taskBudgetUsd, "float"),
    dailyBudgetUsd: readNumber(env, "AGENT_DAILY_BUDGET_USD", defaults.dailyBudgetUsd, "float"),
    critiqueMaxOutputTokens: readNumber(
      env,
      "AGENT_CRITIQUE_MAX_OUTPUT_TOKENS",
      defaults.critiqueMaxOutputTokens,
      "int",
    ),
    repairMaxOutputTokens: readNumber(
      env,
      "AGENT_REPAIR_MAX_OUTPUT_TOKENS",
      defaults.repairMaxOutputTokens,
      "int",
    ),

    visionEnabled: readBoolean(env, "AGENT_VISION_ENABLED", defaults.visionEnabled),
    repairEnabled: readBoolean(env, "AGENT_REPAIR_ENABLED", defaults.repairEnabled),
    visionProviderId: readString(
      env,
      "AGENT_VISION_PROVIDER",
      defaults.visionProviderId,
    ) as AgentConfig["visionProviderId"],
    visionModelId: readString(env, "AGENT_VISION_MODEL", defaults.visionModelId),
    repairModelId: readString(env, "AGENT_REPAIR_MODEL", defaults.repairModelId),

    keepFrames: readBoolean(env, "AGENT_KEEP_FRAMES", defaults.keepFrames),
    jobTtlMs: readNumber(env, "AGENT_JOB_TTL_MS", defaults.jobTtlMs, "int"),
  };

  const parsed = AgentConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path_ = issue.path.join(".");
    const variable = path_
      ? `AGENT_${path_.replace(/[A-Z]/g, (character) => `_${character}`).toUpperCase()}`
      : "AGENT_CONFIG";
    throw new AgentConfigError(variable, issue.message);
  }

  if (parsed.data.maxTotalFrameBytes < parsed.data.maxFrameBytes) {
    throw new AgentConfigError(
      "AGENT_MAX_TOTAL_FRAME_BYTES",
      "must be greater than or equal to AGENT_MAX_FRAME_BYTES",
    );
  }

  return parsed.data;
}
