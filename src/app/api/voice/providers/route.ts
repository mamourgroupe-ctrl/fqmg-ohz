import { NextResponse } from "next/server";
import { LanguageTagSchema } from "@/voice/contracts/voice-contract";
import { getVoiceEngine } from "@/voice/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RETURNED_VOICES_PER_PROVIDER = 100;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const languageTag = LanguageTagSchema.safeParse(url.searchParams.get("languageTag") ?? "ar-DZ");
  if (!languageTag.success) {
    return NextResponse.json({
      error: {
        code: "INVALID_REQUEST",
        message: "languageTag must be a valid BCP-47 language tag.",
        retryable: false,
      },
    }, { status: 400 });
  }

  try {
    const engine = getVoiceEngine();
    const providerHealth = await engine.getProviderHealth(languageTag.data);
    const includeVoices = ["1", "true"].includes((url.searchParams.get("includeVoices") ?? "").toLowerCase());
    const allVoices = includeVoices ? await engine.listVoices(languageTag.data) : [];
    const truncatedProviders: string[] = [];
    const voices = includeVoices
      ? engine.providers.flatMap((provider) => {
        const matchingVoices = allVoices.filter((voice) => voice.providerId === provider.id);
        if (matchingVoices.length > MAX_RETURNED_VOICES_PER_PROVIDER) truncatedProviders.push(provider.id);
        return matchingVoices.slice(0, MAX_RETURNED_VOICES_PER_PROVIDER);
      })
      : undefined;
    const providerHealthById = new Map(providerHealth.map((status) => [status.providerId, status]));
    const configuredProviders = providerHealth.filter((status) => status.configured);
    const verifiedAlgerianVoiceCount = providerHealth.reduce((count, status) => count + status.algerianVoiceCount, 0);
    const algerianAvailabilityStatus = verifiedAlgerianVoiceCount > 0
      ? "verified-in-current-inventory"
      : configuredProviders.length === 0
        ? "providers-not-configured"
        : configuredProviders.some((status) => status.inventoryStatus === "unavailable" || status.inventoryStatus === "unknown")
          ? "inventory-incomplete"
          : "no-verified-algerian-voice-found";

    return NextResponse.json({
      requestedLanguageTag: languageTag.data,
      providers: providerHealth.map((status) => ({
        ...status,
        requiredEnvironment: [...(engine.providers.find((provider) => provider.id === status.providerId)?.requiredEnvironment ?? [])],
      })),
      algerianVoiceAvailability: {
        verifiedInventoryVoiceCount: verifiedAlgerianVoiceCount,
        status: algerianAvailabilityStatus,
      },
      ...(includeVoices ? { voices, truncatedProviders } : {}),
      inventoryCheckedAt: providerHealthById.values().next().value?.checkedAt ?? new Date().toISOString(),
    });
  } catch {
    return NextResponse.json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Voice provider status could not be read safely.",
        retryable: false,
      },
    }, { status: 500 });
  }
}
