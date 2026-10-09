import { describe, expect, it } from "vitest";
import previewSpecification from "../templates/phase-one-preview.json";
import { MotionSpecificationSchema } from "@/motion/schemas/motion-specification";
import { RemotionAdapter } from "@/render/remotion/remotion-adapter";

const specification = MotionSpecificationSchema.parse(previewSpecification);

describe("Remotion adapter", () => {
  it("creates a renderer-specific blueprint from validated data", () => {
    const adapter = new RemotionAdapter();
    const assessment = adapter.assess(specification);
    expect(assessment.supported).toBe(true);
    const blueprint = adapter.createBlueprint(specification);
    expect(blueprint).toMatchObject({
      id: "FQMG-OHZ-NEXT-Preview",
      width: 1080,
      height: 1920,
      fps: 30,
      durationInFrames: 300,
    });
    expect(blueprint.inputProps.spec.scenes).toHaveLength(3);
  });

  it("does not claim Phase 1 support for audio mixing", () => {
    const withAudio = structuredClone(specification);
    withAudio.assets.push({
      id: "voice-file",
      name: "Voice file",
      kind: "audio",
      source: "/uploads/voice.wav",
      licenseStatus: "user-provided",
    });
    withAudio.audio.tracks.push({
      id: "voice-track",
      assetId: "voice-file",
      role: "voice",
      startFrame: 0,
      durationInFrames: 30,
      gain: 1,
      fadeInFrames: 0,
      fadeOutFrames: 0,
    });
    const assessment = new RemotionAdapter().assess(withAudio);
    expect(assessment.supported).toBe(false);
    expect(assessment.reasons.join(" ")).toContain("Audio mixing");
  });
});
