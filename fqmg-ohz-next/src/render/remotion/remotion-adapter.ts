import {
  MotionSpecificationSchema,
  type MotionSpecification,
} from "@/motion/schemas/motion-specification";
import type { RendererAdapter, RendererAssessment } from "@/render/engine/renderer-adapter";

export interface RemotionCompositionBlueprint {
  id: "FQMG-OHZ-NEXT-Preview";
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  inputProps: { spec: MotionSpecification };
}

export class RemotionAdapter implements RendererAdapter<RemotionCompositionBlueprint> {
  readonly engineId = "remotion";

  assess(specification: MotionSpecification): RendererAssessment {
    const parsed = MotionSpecificationSchema.safeParse(specification);
    if (!parsed.success) {
      return {
        supported: false,
        reasons: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      };
    }

    const reasons: string[] = [];
    if (parsed.data.render.engine !== this.engineId) {
      reasons.push(`The requested engine is ${parsed.data.render.engine}, not remotion.`);
    }
    if (parsed.data.audio.tracks.length > 0) {
      reasons.push("Audio mixing is not implemented; audio-bearing projects cannot be rendered yet.");
    }
    if (parsed.data.subtitles.enabled && parsed.data.subtitles.cues.length > 0) {
      reasons.push("Subtitle rendering is reserved for the subtitle phase.");
    }
    if (parsed.data.assets.some((asset) => asset.kind === "font")) {
      reasons.push("Custom font resolution is not implemented in Phase 1.");
    }
    if (parsed.data.assets.some((asset) => asset.source.startsWith("asset://"))) {
      reasons.push("asset:// references need an asset resolver before rendering.");
    }

    return { supported: reasons.length === 0, reasons };
  }

  createBlueprint(specification: MotionSpecification): RemotionCompositionBlueprint {
    const parsed = MotionSpecificationSchema.parse(specification);
    const assessment = this.assess(parsed);
    if (!assessment.supported) {
      throw new Error(`Remotion cannot create this blueprint: ${assessment.reasons.join(" ")}`);
    }

    return {
      id: "FQMG-OHZ-NEXT-Preview",
      width: parsed.composition.width,
      height: parsed.composition.height,
      fps: parsed.composition.fps,
      durationInFrames: parsed.composition.durationInFrames,
      inputProps: { spec: parsed },
    };
  }
}
