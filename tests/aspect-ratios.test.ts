import { describe, expect, it } from "vitest";
import { ASPECT_RATIO_KEYS, ASPECT_RATIO_PRESETS, AspectRatioSchema } from "@/render/presets/aspect-ratios";

const expected = {
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
  "4:5": [1080, 1350],
  "16:9": [1920, 1080],
} as const;

describe("aspect ratio presets", () => {
  it("keeps every requested output size in one typed preset registry", () => {
    expect(ASPECT_RATIO_KEYS).toEqual(["9:16", "1:1", "4:5", "16:9"]);
    for (const [ratio, dimensions] of Object.entries(expected)) {
      expect([ASPECT_RATIO_PRESETS[ratio as keyof typeof ASPECT_RATIO_PRESETS].width, ASPECT_RATIO_PRESETS[ratio as keyof typeof ASPECT_RATIO_PRESETS].height]).toEqual(dimensions);
      expect(AspectRatioSchema.safeParse(ratio).success).toBe(true);
    }
  });

  it("rejects a ratio that is not registered", () => {
    expect(AspectRatioSchema.safeParse("3:2").success).toBe(false);
  });
});
