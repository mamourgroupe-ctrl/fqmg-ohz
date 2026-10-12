import type { FC } from "react";
import { Composition, registerRoot } from "remotion";
import { z } from "zod";
import previewSpecification from "../../templates/phase-one-preview.json";
import { MotionSpecificationSchema } from "@/motion/schemas/motion-specification";
import { MotionComposition, type MotionCompositionProps } from "@/render/remotion/MotionComposition";

const initialSpecification = MotionSpecificationSchema.parse(previewSpecification);
const CompositionInputSchema = z.object({ spec: MotionSpecificationSchema });
type CompositionInput = z.infer<typeof CompositionInputSchema>;

const RemotionRoot: FC = () => (
  <Composition<typeof CompositionInputSchema, CompositionInput>
    id="FQMG-OHZ-Preview"
    schema={CompositionInputSchema}
    component={MotionComposition as FC<MotionCompositionProps>}
    width={initialSpecification.composition.width}
    height={initialSpecification.composition.height}
    fps={initialSpecification.composition.fps}
    durationInFrames={initialSpecification.composition.durationInFrames}
    defaultProps={{ spec: initialSpecification }}
    calculateMetadata={({ props }) => ({
      width: props.spec.composition.width,
      height: props.spec.composition.height,
      fps: props.spec.composition.fps,
      durationInFrames: props.spec.composition.durationInFrames,
    })}
  />
);

registerRoot(RemotionRoot);
