import { describe, expect, it } from "vitest";
import { createDirectorPlan } from "@/ai/director/plan-video";
import { DirectorRequestSchema } from "@/ai/director/request-schema";

describe("provider-agnostic AI Director contract", () => {
  it("creates a validated plan with the requested duration, ratio, locale, and scenes", async () => {
    const result = await createDirectorPlan({
      prompt: "أنشئ إعلانًا تجاريًا أنيقًا لمنتج محلي، من دون اختراع معلومات.",
      durationSeconds: 18,
      aspectRatio: "9:16",
      language: "ar",
      dialect: "ar-DZ",
      voiceGender: "masculine",
    });

    expect(result.providerId).toBe("local-rules");
    expect(result.motionSpecification.composition).toMatchObject({ width: 1080, height: 1920, fps: 30, durationInFrames: 540 });
    expect(result.plan.language).toBe("ar");
    expect(result.plan.dialect).toBe("ar-DZ");
    expect(result.plan.voice.generationStatus).toBe("not-generated");
    expect(result.plan.render.status).toBe("not-rendered");
    expect(result.plan.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0)).toBe(18);
    expect(result.notes.some((note) => note.includes("No external AI provider"))).toBe(true);
  });

  it("accepts a different ratio while keeping dimensions from the shared preset", async () => {
    const result = await createDirectorPlan({
      prompt: "Create a concise product explainer.",
      durationSeconds: 8,
      aspectRatio: "16:9",
      language: "en",
    });
    expect(result.motionSpecification.composition).toMatchObject({ width: 1920, height: 1080, aspectRatio: "16:9" });
  });

  it("uses only supplied brand details and rejects invalid brand colors", async () => {
    const result = await createDirectorPlan({
      prompt: "Create a brand introduction for an existing local business.",
      brand: { name: "Example Workshop", colors: ["#123456"], voiceTone: "warm and direct" },
      language: "en",
    });
    expect(result.motionSpecification.branding).toMatchObject({ name: "Example Workshop", colors: ["#123456"], voiceTone: "warm and direct" });
    expect(result.plan.requiredAssets.some((asset) => asset.kind === "brand-logo")).toBe(true);

    const invalid = DirectorRequestSchema.safeParse({
      prompt: "Create a brand introduction.",
      brand: { name: "Example Workshop", colors: ["orange"] },
    });
    expect(invalid.success).toBe(false);
  });
});
