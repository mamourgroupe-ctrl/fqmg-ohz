import type { DirectorProvider, DirectorBrief } from "./director-provider";
import type { DirectorRequest } from "./request-schema";

export function detectLanguage(prompt: string): "ar" | "fr" | "en" {
  if (/[\u0600-\u06FF]/u.test(prompt)) return "ar";
  if (/\b(le|la|les|bonjour|pour|avec|produit|services?)\b/iu.test(prompt)) return "fr";
  return "en";
}

function inferVideoKind(prompt: string): string {
  if (/(ad|advert|commercial|promo|product|brand|إعلان|منتج|تسويق|خدمة)/iu.test(prompt)) {
    return "product-ad";
  }
  if (/(explain|explainer|شرح|توضيح|كيف يعمل)/iu.test(prompt)) return "explainer";
  return "social-video";
}

function inferVisualStyle(prompt: string): string {
  if (/(premium|luxury|elegant|فاخر|فخم|أنيق)/iu.test(prompt)) return "premium commercial";
  if (/(playful|fun|مرح|ممتع)/iu.test(prompt)) return "playful, energetic";
  if (/(minimal|clean|بسيط|هادئ)/iu.test(prompt)) return "clean, minimal";
  return "clean commercial, subject-led";
}

/**
 * Dependency-free planning fallback. It is intentionally deterministic and does not call an LLM.
 * Replace it with a credential-checked provider adapter in a later phase.
 */
export class LocalRulesDirectorProvider implements DirectorProvider {
  readonly id = "local-rules";

  async generateBrief(request: DirectorRequest): Promise<DirectorBrief> {
    const language = request.language ?? detectLanguage(request.prompt);
    const productOrService = request.productOrService ?? request.brand?.name ?? request.prompt.slice(0, 120).trim();
    const requestedMusic = /(music|soundtrack|موسيقى|موسيقي|bande sonore)/iu.test(request.prompt);
    const requiredAssets: DirectorBrief["requiredAssets"] = [];

    if (inferVideoKind(request.prompt) === "product-ad") {
      requiredAssets.push({
        kind: "product-image-or-video",
        description: "User-provided product imagery; do not invent product claims or use unlicensed stock.",
        required: true,
      });
    }

    if (request.brand?.name) {
      requiredAssets.push({
        kind: "brand-logo",
        description: `Optional user-provided logo for ${request.brand.name}.`,
        required: false,
      });
    }

    const dialect = request.dialect;
    return {
      videoKind: inferVideoKind(request.prompt),
      language,
      ...(dialect ? { dialect } : {}),
      targetAudience: request.targetAudience ?? "General audience — confirm with the project owner.",
      productOrService,
      visualStyle: request.visualStyle ?? inferVisualStyle(request.prompt),
      voice: {
        requested: true,
        providerPreference: "AUTO",
        gender: request.voiceGender,
        language,
        ...(dialect ? { dialect } : {}),
        generationStatus: "not-generated",
      },
      music: {
        requested: requestedMusic,
        intent: requestedMusic ? "User requested music; style needs confirmation." : "No music specified.",
        generationStatus: "not-generated",
        licensingNote: "Use only a user-provided or separately licensed music asset.",
      },
      requiredAssets,
    };
  }
}
