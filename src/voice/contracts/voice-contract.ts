import { z } from "zod";

export const MAX_VOICE_TEXT_CHARACTERS = 10_000;
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

export const VoiceProviderIdSchema = z.enum([
  "azure-speech",
  "elevenlabs",
  "google-cloud",
  "openai",
]);
export type VoiceProviderId = z.infer<typeof VoiceProviderIdSchema>;

export const VoiceProviderPreferenceSchema = z.union([
  z.literal("auto"),
  VoiceProviderIdSchema,
]);
export type VoiceProviderPreference = z.infer<typeof VoiceProviderPreferenceSchema>;

const LanguageTagInputSchema = z
  .string()
  .trim()
  .min(2)
  .max(35)
  .regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/, "Expected a BCP-47 language tag.");

/** Canonicalizes valid BCP-47 tags (for example, ar-dz becomes ar-DZ). */
export const LanguageTagSchema = LanguageTagInputSchema
  .refine((tag) => {
    try {
      return Intl.getCanonicalLocales(tag).length === 1;
    } catch {
      return false;
    }
  }, "Expected a valid BCP-47 language tag.")
  .transform((tag) => Intl.getCanonicalLocales(tag)[0]);
export type LanguageTag = z.infer<typeof LanguageTagSchema>;

export function normalizeVoiceText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .trim();
}

const VoiceTextSchema = z
  .string()
  .max(MAX_VOICE_TEXT_CHARACTERS)
  .transform(normalizeVoiceText)
  .pipe(z.string().min(1).max(MAX_VOICE_TEXT_CHARACTERS));

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

const SafeIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !hasControlCharacters(value), "Identifiers cannot contain control characters.");

const ProjectIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Project IDs may contain letters, digits, hyphens, and underscores.");

function normalizeVoiceDescriptor(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

const ShortLabelSchema = z.string().trim().min(1).max(120);
const VoiceStyleSchema = z.string().max(120).transform(normalizeVoiceDescriptor).pipe(z.string().min(1).max(120));
const VoiceDialectSchema = z.string().max(80).transform(normalizeVoiceDescriptor).pipe(z.string().min(1).max(80));

export const VoiceGenderSchema = z.enum(["female", "male", "neutral", "unknown"]);
export type VoiceGender = z.infer<typeof VoiceGenderSchema>;

export const VoiceCapabilityEvidenceSourceSchema = z.enum([
  "account-inventory",
  "provider-documentation",
  "manual-selection",
]);

export const VoiceCapabilityConfidenceSchema = z.enum([
  "exact-locale-inventory",
  "verified-dialect-inventory",
  "verified-language-inventory",
  "documented-language-only",
  "manual-unverified",
]);
export type VoiceCapabilityConfidence = z.infer<typeof VoiceCapabilityConfidenceSchema>;

/** Normalized, provider-independent metadata. Provider labels remain evidence, not promises. */
export const VoiceProfileSchema = z.object({
  providerId: VoiceProviderIdSchema,
  voiceId: SafeIdentifierSchema,
  displayName: ShortLabelSchema.optional(),
  modelId: SafeIdentifierSchema.optional(),
  languageTags: z.array(LanguageTagSchema).max(100).default([]),
  localeTags: z.array(LanguageTagSchema).max(100).default([]),
  verifiedLanguageTags: z.array(LanguageTagSchema).max(100).default([]),
  verifiedDialects: z.array(VoiceStyleSchema).max(100).default([]),
  styles: z.array(VoiceStyleSchema).max(100).default([]),
  gender: VoiceGenderSchema.optional(),
  evidenceSource: VoiceCapabilityEvidenceSourceSchema,
  observedAt: z.string().datetime().optional(),
});
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

export const VoiceSelectionSchema = z.object({
  providerId: VoiceProviderIdSchema,
  voiceId: SafeIdentifierSchema,
  voiceName: ShortLabelSchema.optional(),
  modelId: SafeIdentifierSchema.optional(),
  languageTag: LanguageTagSchema,
  dialect: VoiceDialectSchema.optional(),
  matchedLocaleTag: LanguageTagSchema.optional(),
  capabilityConfidence: VoiceCapabilityConfidenceSchema,
  selectedAt: z.string().datetime(),
});
export type VoiceSelection = z.infer<typeof VoiceSelectionSchema>;

const NormalizedVoiceSynthesisRequestSchema = z
  .object({
    projectId: ProjectIdSchema,
    text: VoiceTextSchema,
    languageTag: LanguageTagSchema,
    dialect: VoiceDialectSchema.optional(),
    provider: VoiceProviderPreferenceSchema.default("auto"),
    voiceId: SafeIdentifierSchema.optional(),
    voiceStyle: VoiceStyleSchema.optional(),
    speakingRate: z.number().min(0.7).max(1.2).default(1),
    outputFormat: z.literal("mp3").default("mp3"),
    allowUnverifiedDialect: z.boolean().default(false),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.provider === "auto" && request.voiceId) {
      ctx.addIssue({
        code: "custom",
        path: ["voiceId"],
        message: "Choose a provider when supplying an explicit voice ID.",
      });
    }
  });

export const VoiceSynthesisRequestSchema = NormalizedVoiceSynthesisRequestSchema;
export type VoiceSynthesisRequest = z.infer<typeof VoiceSynthesisRequestSchema>;

/** Every field that can alter synthesized speech participates in the deterministic cache identity. */
export const VoiceSynthesisIdentitySchema = z.object({
  version: z.literal(1),
  providerId: VoiceProviderIdSchema,
  modelId: SafeIdentifierSchema,
  voiceId: SafeIdentifierSchema,
  text: VoiceTextSchema,
  requestedLanguageTag: LanguageTagSchema,
  synthesisLanguageTag: LanguageTagSchema,
  dialect: VoiceDialectSchema.optional(),
  voiceStyle: VoiceStyleSchema.optional(),
  speakingRate: z.number().min(0.7).max(1.2),
  outputFormat: z.literal("mp3"),
}).strict();
export type VoiceSynthesisIdentity = z.infer<typeof VoiceSynthesisIdentitySchema>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const VoiceAudioReferenceSchema = z
  .object({
    id: z.string().regex(UUID_PATTERN, "Audio reference ID must be a UUID."),
    href: z.string().regex(
      /^\/api\/voice\/audio\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      "Audio must be served from the managed voice-audio API route.",
    ),
    mimeType: z.literal("audio/mpeg"),
    sizeBytes: z.number().int().positive().max(MAX_AUDIO_BYTES),
  })
  .superRefine((reference, ctx) => {
    if (reference.href !== `/api/voice/audio/${reference.id}`) {
      ctx.addIssue({ code: "custom", path: ["href"], message: "Audio route ID must match the reference ID." });
    }
  });
export type VoiceAudioReference = z.infer<typeof VoiceAudioReferenceSchema>;

export const VoiceFallbackDisclosureSchema = z.object({
  fromProviderId: VoiceProviderIdSchema,
  toProviderId: VoiceProviderIdSchema,
  reason: z.enum(["timeout", "rate-limited", "provider-unavailable", "provider-error", "pinned-voice-unavailable"]),
  message: z.string().trim().min(1).max(500),
  dialectVerified: z.boolean(),
});
export type VoiceFallbackDisclosure = z.infer<typeof VoiceFallbackDisclosureSchema>;

export const VoiceSynthesisResultSchema = z.object({
  projectId: ProjectIdSchema,
  requestedProvider: VoiceProviderPreferenceSchema,
  usedProviderId: VoiceProviderIdSchema,
  selectedVoice: VoiceSelectionSchema,
  audio: VoiceAudioReferenceSchema,
  cacheHit: z.boolean(),
  latencyMs: z.number().finite().nonnegative(),
  fallback: VoiceFallbackDisclosureSchema.optional(),
  disclosures: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
  completedAt: z.string().datetime(),
});
export type VoiceSynthesisResult = z.infer<typeof VoiceSynthesisResultSchema>;

export const VoiceProviderHealthSchema = z.object({
  providerId: VoiceProviderIdSchema,
  configured: z.boolean(),
  status: z.enum(["not-configured", "unknown", "healthy", "degraded", "unhealthy"]),
  inventoryStatus: z.enum(["not-configured", "unknown", "available", "empty", "unavailable"]).default("unknown"),
  voiceCount: z.number().int().nonnegative(),
  algerianVoiceCount: z.number().int().nonnegative(),
  recentSuccessRate: z.number().min(0).max(1).nullable(),
  meanLatencyMs: z.number().finite().nonnegative().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastSuccessAt: z.string().datetime().optional(),
  lastFailureAt: z.string().datetime().optional(),
  checkedAt: z.string().datetime(),
});
export type VoiceProviderHealth = z.infer<typeof VoiceProviderHealthSchema>;

export const VoiceApiErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "PROVIDER_NOT_CONFIGURED",
  "PROJECT_VOICE_CONFLICT",
  "NO_COMPATIBLE_VOICE",
  "UNVERIFIED_DIALECT",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "SYNTHESIS_FAILED",
  "AUDIO_NOT_FOUND",
  "INTERNAL_ERROR",
]);
export type VoiceApiErrorCode = z.infer<typeof VoiceApiErrorCodeSchema>;

export const VoiceApiErrorSchema = z.object({
  error: z.object({
    code: VoiceApiErrorCodeSchema,
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
  }),
});
export type VoiceApiError = z.infer<typeof VoiceApiErrorSchema>;
