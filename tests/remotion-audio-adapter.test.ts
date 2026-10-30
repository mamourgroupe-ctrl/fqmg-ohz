import { describe, expect, it } from "vitest";
import previewSpecification from "../templates/phase-one-preview.json";
import {
  MotionSpecificationSchema,
  type MotionSpecification,
} from "@/motion/schemas/motion-specification";
import { RemotionAdapter } from "@/render/remotion/remotion-adapter";

/**
 * Phase-7 adapter contract for audio-bearing projects: the old blanket
 * rejection ("Audio mixing is not implemented") is lifted exactly as far as
 * the implemented mixing goes — timing (startFrame/durationInFrames),
 * levels (gain x masterVolume) and fades. normalize/ducking stay
 * fail-closed, and tracks must reference a known asset id.
 */

function specWithAudio(overrides: {
  tracks?: Array<Record<string, unknown>>;
  assets?: Array<Record<string, unknown>>;
  normalize?: boolean;
  ducking?: boolean;
}): MotionSpecification {
  return MotionSpecificationSchema.parse(buildSpecWithAudio(overrides));
}

/** Same merge as specWithAudio but WITHOUT schema parsing: the adapter's
 * own safeParse must be the first validation for invalid-case tests. */
function buildSpecWithAudio(overrides: {
  tracks?: Array<Record<string, unknown>>;
  assets?: Array<Record<string, unknown>>;
  normalize?: boolean;
  ducking?: boolean;
}): Record<string, unknown> {
  const base = previewSpecification as Record<string, unknown>;
  return {
    ...base,
    assets: (base.assets as Array<Record<string, unknown>>).concat(
      overrides.assets ?? [
        {
          kind: "audio",
          id: "tone-asset",
          name: "Tone",
          source: "/assets/tone.wav",
          mimeType: "audio/wav",
          licenseStatus: "generated",
        },
      ],
    ),
    audio: {
      tracks: overrides.tracks ?? [
        {
          id: "track-1",
          assetId: "tone-asset",
          role: "music",
          startFrame: 0,
          durationInFrames: 30,
          gain: 0.8,
          fadeInFrames: 6,
          fadeOutFrames: 6,
        },
      ],
      masterVolume: 0.9,
      normalize: overrides.normalize ?? false,
      ducking: overrides.ducking ?? false,
    },
  };
}

describe("RemotionAdapter audio assessment (phase 7)", () => {
  const adapter = new RemotionAdapter();

  it("accepts a project whose audio tracks are mixable", () => {
    const assessment = adapter.assess(specWithAudio({}));
    expect(assessment.supported).toBe(true);
  });

  it("rejects tracks that reference an unknown asset id (schema-enforced)", () => {
    // Built WITHOUT pre-parsing: the adapter's safeParse is the first
    // validation, and the schema refinement is the source of truth.
    const assessment = adapter.assess(
      buildSpecWithAudio({
        tracks: [
          {
            id: "track-1",
            assetId: "missing-asset",
            role: "music",
            startFrame: 0,
            durationInFrames: 30,
          },
        ],
      }) as unknown as MotionSpecification,
    );
    expect(assessment.supported).toBe(false);
    // The schema refinement is the single source of truth for track->asset
    // integrity; the adapter surfaces its issue as an assessment reason.
    expect(assessment.reasons.join(" ")).toMatch(/existing audio or video asset/i);
  });

  it("stays fail-closed on audio.normalize", () => {
    const assessment = adapter.assess(specWithAudio({ normalize: true }));
    expect(assessment.supported).toBe(false);
    expect(assessment.reasons.join(" ")).toMatch(/normalization/i);
  });

  it("stays fail-closed on audio.ducking", () => {
    const assessment = adapter.assess(specWithAudio({ ducking: true }));
    expect(assessment.supported).toBe(false);
    expect(assessment.reasons.join(" ")).toMatch(/ducking/i);
  });

  it("keeps rejecting asset:// sources (no resolver yet)", () => {
    const assessment = adapter.assess(
      specWithAudio({
        assets: [
          {
            kind: "audio",
            id: "remote-tone",
            name: "Remote tone",
            source: "asset://library/tone.wav",
          },
        ],
        tracks: [
          {
            id: "track-1",
            assetId: "remote-tone",
            role: "music",
            startFrame: 0,
            durationInFrames: 30,
          },
        ],
      }),
    );
    expect(assessment.supported).toBe(false);
    expect(assessment.reasons.join(" ")).toMatch(/asset:\/\//);
  });
});
