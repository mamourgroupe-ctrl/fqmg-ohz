import { z } from "zod";
import { MotionSpecificationSchema } from "@/motion/schemas/motion-specification";
import { VoiceSynthesisRequestSchema } from "@/voice/contracts/voice-contract";
import { VoiceTrackPlacementSchema } from "@/voice/project/apply-voice-to-motion-specification";

export const VoiceSynthesisApiRequestSchema = z.object({
  synthesis: VoiceSynthesisRequestSchema,
  motionSpecification: MotionSpecificationSchema.optional(),
  placement: VoiceTrackPlacementSchema.optional(),
}).strict().superRefine((request, ctx) => {
  if (Boolean(request.motionSpecification) !== Boolean(request.placement)) {
    ctx.addIssue({
      code: "custom",
      path: [request.motionSpecification ? "placement" : "motionSpecification"],
      message: "Include both motionSpecification and placement when attaching generated audio to a project.",
    });
  }

  if (request.motionSpecification && request.placement) {
    if (request.motionSpecification.project.id !== request.synthesis.projectId) {
      ctx.addIssue({
        code: "custom",
        path: ["motionSpecification", "project", "id"],
        message: "The voice request and Motion Specification must use the same project ID.",
      });
    }

    if (request.placement.startFrame + request.placement.durationInFrames > request.motionSpecification.composition.durationInFrames) {
      ctx.addIssue({
        code: "custom",
        path: ["placement", "durationInFrames"],
        message: "Voice track timing must fit inside the composition duration.",
      });
    }
    if (request.motionSpecification.assets.length >= 500) {
      ctx.addIssue({
        code: "custom",
        path: ["motionSpecification", "assets"],
        message: "The project has no room for another managed voice asset.",
      });
    }
    if (request.motionSpecification.audio.tracks.length >= 64) {
      ctx.addIssue({
        code: "custom",
        path: ["motionSpecification", "audio", "tracks"],
        message: "The project has no room for another audio track.",
      });
    }
  }

  if (
    request.motionSpecification?.audio.voiceSelection &&
    request.synthesis.provider !== "auto" &&
    request.motionSpecification.audio.voiceSelection.providerId !== request.synthesis.provider &&
    !request.placement?.allowVoiceChange
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["synthesis", "provider"],
      message: "Changing a project's pinned voice provider requires explicit confirmation.",
    });
  }

  if (
    request.motionSpecification?.audio.voiceSelection?.voiceId &&
    request.synthesis.voiceId &&
    request.motionSpecification.audio.voiceSelection.voiceId !== request.synthesis.voiceId &&
    !request.placement?.allowVoiceChange
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["synthesis", "voiceId"],
      message: "Changing a project's pinned voice requires explicit confirmation.",
    });
  }
});

export type VoiceSynthesisApiRequest = z.infer<typeof VoiceSynthesisApiRequestSchema>;
