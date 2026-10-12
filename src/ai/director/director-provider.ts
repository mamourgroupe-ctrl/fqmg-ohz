import type { DirectorRequest } from "./request-schema";

export interface DirectorBrief {
  videoKind: string;
  language: "ar" | "fr" | "en";
  dialect?: string;
  targetAudience: string;
  productOrService: string;
  visualStyle: string;
  voice: {
    requested: boolean;
    providerPreference: "AUTO";
    gender: DirectorRequest["voiceGender"];
    language: "ar" | "fr" | "en";
    dialect?: string;
    generationStatus: "not-generated";
  };
  music: {
    requested: boolean;
    intent: string;
    generationStatus: "not-generated";
    licensingNote: string;
  };
  requiredAssets: Array<{
    kind: "product-image-or-video" | "brand-logo" | "other";
    description: string;
    required: boolean;
  }>;
}

/** Providers return a structured brief; they never return executable renderer code. */
export interface DirectorProvider {
  readonly id: string;
  generateBrief(request: DirectorRequest): Promise<DirectorBrief>;
}
