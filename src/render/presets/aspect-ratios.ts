import { z } from "zod";

export const ASPECT_RATIO_PRESETS = {
  "9:16": { width: 1080, height: 1920, label: "عمودي 9:16" },
  "1:1": { width: 1080, height: 1080, label: "مربع 1:1" },
  "4:5": { width: 1080, height: 1350, label: "منشور 4:5" },
  "16:9": { width: 1920, height: 1080, label: "أفقي 16:9" },
} as const;

export const ASPECT_RATIO_KEYS = ["9:16", "1:1", "4:5", "16:9"] as const;
export const AspectRatioSchema = z.enum(ASPECT_RATIO_KEYS);
export type AspectRatioPreset = z.infer<typeof AspectRatioSchema>;

export function getAspectRatioPreset(ratio: AspectRatioPreset) {
  return ASPECT_RATIO_PRESETS[ratio];
}
