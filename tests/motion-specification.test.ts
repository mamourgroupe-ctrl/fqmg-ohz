import { describe, expect, it } from "vitest";
import previewSpecification from "../templates/phase-one-preview.json";
import { MotionSpecificationSchema } from "@/motion/schemas/motion-specification";

const validMotion = MotionSpecificationSchema.parse(previewSpecification);

describe("Motion Specification schema", () => {
  it("accepts the complete starter composition", () => {
    const result = MotionSpecificationSchema.safeParse(validMotion);
    expect(result.success).toBe(true);
    expect(result.success && result.data.scenes).toHaveLength(3);
  });

  it("rejects dimensions that do not match the central ratio preset", () => {
    const invalid = structuredClone(validMotion);
    invalid.composition.width = 360;
    const result = MotionSpecificationSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues.some((issue) => issue.path.includes("width"))).toBe(true);
  });

  it("rejects a scene that runs past the composition end", () => {
    const invalid = structuredClone(validMotion);
    invalid.scenes[2].durationInFrames += 60;
    const result = MotionSpecificationSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects executable/data URLs for assets", () => {
    const invalid = structuredClone(validMotion);
    invalid.assets.push({
      id: "unsafe-asset",
      name: "unsafe",
      kind: "image",
      source: "javascript:alert(1)",
      licenseStatus: "unknown",
    });
    expect(MotionSpecificationSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects HTTPS asset references that embed credentials", () => {
    const invalid = structuredClone(validMotion);
    invalid.assets.push({
      id: "credential-url",
      name: "credential-bearing source",
      kind: "audio",
      source: "https://user:secret@example.test/audio.mp3",
      licenseStatus: "user-provided",
    });
    expect(MotionSpecificationSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects dangling image references", () => {
    const invalid = structuredClone(validMotion);
    invalid.scenes[0].layers.push({
      id: "missing-image-layer",
      name: "Missing image",
      type: "image",
      assetId: "not-in-assets",
      alt: "",
      fit: "cover",
      startFrame: 0,
      durationInFrames: 30,
      opacity: 1,
      layout: { xPercent: 50, yPercent: 50, widthPercent: 50, heightPercent: 50 },
      keyframes: [],
    });
    expect(MotionSpecificationSchema.safeParse(invalid).success).toBe(false);
  });

  it("preserves Arabic subtitle direction and timing", () => {
    const localized = structuredClone(validMotion);
    localized.subtitles = {
      ...localized.subtitles,
      enabled: true,
      language: "ar",
      direction: "rtl",
      cues: [{
        id: "arabic-caption",
        text: "مرحبا بالعالم",
        language: "ar-DZ",
        direction: "rtl",
        startFrame: 12,
        durationInFrames: 42,
        words: [
          { text: "مرحبا", startFrame: 12, durationInFrames: 18 },
          { text: "بالعالم", startFrame: 30, durationInFrames: 24 },
        ],
      }],
    };
    const parsed = MotionSpecificationSchema.parse(localized);
    expect(parsed.subtitles.direction).toBe("rtl");
    expect(parsed.subtitles.cues[0].words).toHaveLength(2);
  });
});
