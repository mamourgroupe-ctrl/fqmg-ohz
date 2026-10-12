import type { AspectRatioPreset } from "@/render/presets/aspect-ratios";
import { SceneSchema, type SceneSpec } from "@/motion/schemas/motion-specification";

export type PlannerLanguage = "ar" | "fr" | "en";

export interface ScenePlannerInput {
  durationInFrames: number;
  fps: number;
  language: PlannerLanguage;
  aspectRatio: AspectRatioPreset;
}

const BEATS = ["hook", "problem", "solution", "cta"] as const;
const WEIGHTS = [0.17, 0.23, 0.38, 0.22] as const;

const COPY: Record<PlannerLanguage, { titles: string[]; overlays: string[] }> = {
  ar: {
    titles: ["الخطّاف", "التحدّي", "الحلّ والفوائد", "الخطوة التالية"],
    overlays: ["بداية لافتة", "وضّح التحدّي", "قدّم الحلّ بوضوح", "دعوة واضحة لاتخاذ إجراء"],
  },
  fr: {
    titles: ["Accroche", "Le défi", "La solution", "Passez à l’action"],
    overlays: ["Une ouverture marquante", "Présentez le défi", "Présentez la solution", "Un appel à l’action clair"],
  },
  en: {
    titles: ["Hook", "The challenge", "The solution", "Next step"],
    overlays: ["Open with a clear hook", "Frame the challenge", "Show the solution", "Add a clear call to action"],
  },
};

export function planScenes(input: ScenePlannerInput): SceneSpec[] {
  if (!Number.isInteger(input.durationInFrames) || input.durationInFrames < BEATS.length) {
    throw new RangeError(`durationInFrames must be an integer of at least ${BEATS.length}.`);
  }

  if (!Number.isInteger(input.fps) || input.fps < 1) {
    throw new RangeError("fps must be a positive integer.");
  }

  const copy = COPY[input.language];
  const remainingFrames = input.durationInFrames - BEATS.length;
  const durations = BEATS.map(() => 1);
  let assignedExtraFrames = 0;
  for (let index = 0; index < WEIGHTS.length - 1; index += 1) {
    const extraFrames = Math.floor(remainingFrames * WEIGHTS[index]);
    durations[index] += extraFrames;
    assignedExtraFrames += extraFrames;
  }
  durations[durations.length - 1] += remainingFrames - assignedExtraFrames;

  let startFrame = 0;
  return BEATS.map((beat, index) => {
    const durationInFrames = durations[index];
    const scene = SceneSchema.parse({
      id: `scene-${String(index + 1).padStart(2, "0")}`,
      title: copy.titles[index],
      beat,
      startFrame,
      durationInFrames,
      transition: index === 0 ? { type: "cut", durationInFrames: 0 } : {
        type: "fade",
        durationInFrames: Math.min(Math.round(input.fps * 0.25), Math.max(1, Math.floor(durationInFrames / 3))),
      },
      layers: [
        {
          id: `layer-${String(index + 1).padStart(2, "0")}-headline`,
          name: "Scene headline placeholder",
          type: "text",
          content: copy.overlays[index],
          startFrame: 0,
          durationInFrames,
          opacity: 1,
          layout: {
            xPercent: 50,
            yPercent: input.aspectRatio === "16:9" ? 50 : 58,
            widthPercent: 88,
            heightPercent: 34,
          },
          keyframes: durationInFrames > 1
            ? [
                { property: "opacity", frame: 0, value: 0, easing: "ease-out" },
                { property: "opacity", frame: Math.min(12, durationInFrames - 1), value: 1, easing: "ease-out" },
                { property: "yPercent", frame: 0, value: input.aspectRatio === "16:9" ? 53 : 62, easing: "ease-out" },
                { property: "yPercent", frame: Math.min(12, durationInFrames - 1), value: input.aspectRatio === "16:9" ? 50 : 58, easing: "ease-out" },
              ]
            : [],
          style: {
            fontFamily: "Arial, sans-serif",
            fontSize: input.aspectRatio === "16:9" ? 72 : 64,
            color: "#FFFFFF",
            alignment: "center",
            direction: input.language === "ar" ? "rtl" : "ltr",
            weight: "bold",
          },
        },
      ],
    });

    startFrame += durationInFrames;
    return scene;
  });
}
