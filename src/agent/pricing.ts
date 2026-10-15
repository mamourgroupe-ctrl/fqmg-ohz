import { z } from "zod";

/**
 * Provider pricing used by the budget gate.
 *
 * IMPORTANT: this repository ships an EMPTY price book on purpose.
 * Provider pricing could not be verified from this environment (only GitHub, npm, and PyPI are
 * reachable), and a guessed price is worse than no price: a wrong estimate would let the
 * application believe it respects the owner's USD 0.03 / USD 0.25 policy while it does not.
 *
 * Consequence: with no verified price, `estimateCost` returns undefined, and the budget ledger
 * fails closed and rejects the paid request. An operator who has read the provider's official
 * pricing page can add prices with the AGENT_PRICE_* environment variables; each such entry is
 * recorded with its source URL and verification date so the estimate stays auditable.
 */

export const TokenPricingSchema = z.object({
  providerId: z.string().min(1).max(80),
  modelId: z.string().min(1).max(160),
  unit: z.literal("per-million-tokens"),
  inputUsdPerMillionTokens: z.number().finite().nonnegative().max(10_000),
  outputUsdPerMillionTokens: z.number().finite().nonnegative().max(10_000),
  sourceUrl: z
    .string()
    .min(8)
    .max(2_048)
    .refine((value) => value.startsWith("https://"), "Pricing sources must be HTTPS URLs."),
  verifiedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date (YYYY-MM-DD)."),
  notes: z.string().max(400).optional(),
});

export type TokenPricing = z.infer<typeof TokenPricingSchema>;

export const PriceBookSchema = z.object({
  entries: z.array(TokenPricingSchema).max(64),
});

export type PriceBook = z.infer<typeof PriceBookSchema>;

export const EMPTY_PRICE_BOOK: PriceBook = { entries: [] };

export interface TokenUsageEstimate {
  inputTokens: number;
  outputTokens: number;
}

export const TokenUsageEstimateSchema = z.object({
  inputTokens: z.number().int().nonnegative().max(10_000_000),
  outputTokens: z.number().int().nonnegative().max(10_000_000),
});

export interface CostEstimate {
  usd: number;
  basis: string;
  pricing: TokenPricing;
  usage: TokenUsageEstimate;
}

type Environment = Readonly<Record<string, string | undefined>>;

function readPairedNumber(
  env: Environment,
  variable: string,
): number | undefined {
  const raw = env[variable]?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+(?:\.\d+)?(?:e-?\d+)?$/i.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Operator-supplied price overrides. Both prices, both model ids, and the source URL must be
 * present; a partially configured price is ignored (and therefore fails closed later).
 */
export function loadPriceBook(env: Environment = process.env): PriceBook {
  const entries: TokenPricing[] = [];
  const pairs: Array<{ providerVariable: string; modelVariable: string }> = [
    { providerVariable: "AGENT_VISION_PROVIDER", modelVariable: "AGENT_VISION_MODEL" },
    { providerVariable: "AGENT_REPAIR_PROVIDER", modelVariable: "AGENT_REPAIR_MODEL" },
  ];

  for (const { providerVariable, modelVariable } of pairs) {
    const providerId = env[providerVariable]?.trim();
    const modelId = env[modelVariable]?.trim();
    const input = readPairedNumber(env, "AGENT_PRICE_INPUT_PER_MTOK");
    const output = readPairedNumber(env, "AGENT_PRICE_OUTPUT_PER_MTOK");
    if (!providerId || !modelId || input === undefined || output === undefined) continue;

    const candidate = {
      providerId,
      modelId,
      unit: "per-million-tokens" as const,
      inputUsdPerMillionTokens: input,
      outputUsdPerMillionTokens: output,
      sourceUrl: env.AGENT_PRICE_SOURCE_URL?.trim() ?? "",
      verifiedOn: env.AGENT_PRICE_VERIFIED_ON?.trim() ?? "",
      ...(env.AGENT_PRICE_NOTES?.trim() ? { notes: env.AGENT_PRICE_NOTES.trim() } : {}),
    };

    const parsed = TokenPricingSchema.safeParse(candidate);
    if (parsed.success) entries.push(parsed.data);
  }

  return { entries };
}

export function findPricing(
  priceBook: PriceBook,
  providerId: string,
  modelId: string,
): TokenPricing | undefined {
  return priceBook.entries.find(
    (entry) => entry.providerId === providerId && entry.modelId === modelId,
  );
}

/**
 * Tokens for an image are approximated from the decoded pixel count. The divisor is
 * deliberately pessimistic (more tokens than the common width*height/750 rule), so the
 * estimate is an upper bound rather than an optimistic guess.
 */
export const IMAGE_TOKEN_DIVISOR = 500;

export function estimateImageTokens(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0;
  return Math.ceil((width * height) / IMAGE_TOKEN_DIVISOR);
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildUsageEstimate(input: {
  imagePixels?: Array<{ width: number; height: number }>;
  promptText?: string;
  maxOutputTokens: number;
}): TokenUsageEstimate {
  const imageTokens = (input.imagePixels ?? []).reduce(
    (total, image) => total + estimateImageTokens(image.width, image.height),
    0,
  );
  return TokenUsageEstimateSchema.parse({
    inputTokens: imageTokens + estimateTextTokens(input.promptText ?? ""),
    outputTokens: input.maxOutputTokens,
  });
}

/**
 * Cost for a synchronously priced token model. Returns undefined when the price is unknown,
 * which the caller must treat as "cannot determine cost reliably" and reject.
 */
export function estimateCost(input: {
  priceBook: PriceBook;
  providerId: string;
  modelId: string;
  usage: TokenUsageEstimate;
}): CostEstimate | undefined {
  const pricing = findPricing(input.priceBook, input.providerId, input.modelId);
  if (!pricing) return undefined;

  const parsedUsage = TokenUsageEstimateSchema.safeParse(input.usage);
  if (!parsedUsage.success) return undefined;

  const { inputTokens, outputTokens } = parsedUsage.data;
  const usd =
    (inputTokens / 1_000_000) * pricing.inputUsdPerMillionTokens +
    (outputTokens / 1_000_000) * pricing.outputUsdPerMillionTokens;

  if (!Number.isFinite(usd) || usd < 0) return undefined;

  return {
    // Round up to the sixth decimal so the estimate never understates a micro-cent of cost.
    usd: Math.ceil(usd * 1_000_000) / 1_000_000,
    basis: `${inputTokens} input token(s) + ${outputTokens} output token(s) at USD ${pricing.inputUsdPerMillionTokens}/${pricing.outputUsdPerMillionTokens} per million (verified ${pricing.verifiedOn} via ${pricing.sourceUrl})`,
    pricing,
    usage: parsedUsage.data,
  };
}
