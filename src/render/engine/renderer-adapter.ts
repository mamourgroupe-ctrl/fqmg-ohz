import type { MotionSpecification } from "@/motion/schemas/motion-specification";

export interface RendererAssessment {
  supported: boolean;
  reasons: string[];
}

/** A target adapter translates validated data into a renderer-specific blueprint. */
export interface RendererAdapter<TBlueprint> {
  readonly engineId: string;
  assess(specification: MotionSpecification): RendererAssessment;
  createBlueprint(specification: MotionSpecification): TBlueprint;
}
