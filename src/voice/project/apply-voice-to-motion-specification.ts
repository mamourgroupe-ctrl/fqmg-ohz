import {
  AudioTrackSchema,
  AssetSpecSchema,
  MotionSpecificationSchema,
  type MotionSpecification,
} from "@/motion/schemas/motion-specification";
import {
  VoiceAudioReferenceSchema,
  VoiceSelectionSchema,
  VoiceSynthesisResultSchema,
  type VoiceSynthesisResult,
} from "@/voice/contracts/voice-contract";
import { z } from "zod";

export const VoiceTrackPlacementSchema = z.object({
  startFrame: z.number().int().nonnegative(),
  durationInFrames: z.number().int().positive().max(108_000),
  gain: z.number().min(0).max(2).default(1),
  fadeInFrames: z.number().int().nonnegative().default(0),
  fadeOutFrames: z.number().int().nonnegative().default(0),
  allowVoiceChange: z.boolean().default(false),
}).strict().superRefine((placement, ctx) => {
  if (placement.fadeInFrames + placement.fadeOutFrames > placement.durationInFrames) {
    ctx.addIssue({
      code: "custom",
      path: ["fadeInFrames"],
      message: "Voice fades cannot exceed the track duration.",
    });
  }
});

export interface VoiceTrackPlacement {
  startFrame: number;
  durationInFrames: number;
  gain?: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  allowVoiceChange?: boolean;
}

function sameVoiceIdentity(
  left: z.infer<typeof VoiceSelectionSchema>,
  right: z.infer<typeof VoiceSelectionSchema>,
): boolean {
  return left.providerId === right.providerId &&
    left.voiceId === right.voiceId &&
    (left.modelId ?? "") === (right.modelId ?? "");
}

function chooseAssetId(specification: MotionSpecification, referenceId: string): string {
  const baseId = `voice-audio-${referenceId}`;
  const existing = specification.assets.find((asset) => asset.id === baseId);
  if (existing) {
    if (existing.kind === "audio" && existing.source === `/api/voice/audio/${referenceId}`) return baseId;
    throw new Error("The managed voice asset ID conflicts with an existing project asset.");
  }
  return baseId;
}

function chooseTrackId(specification: MotionSpecification, referenceId: string): string {
  const baseId = `voice-track-${referenceId}`;
  if (!specification.audio.tracks.some((track) => track.id === baseId)) return baseId;
  let suffix = 2;
  while (specification.audio.tracks.some((track) => track.id === `${baseId}-${suffix}`)) suffix += 1;
  const trackId = `${baseId}-${suffix}`;
  if (trackId.length > 64) throw new Error("The project has too many voice tracks for a unique track ID.");
  return trackId;
}

/** Attach a managed audio result without changing the existing renderer's fail-closed audio behavior. */
export function applyVoiceResultToMotionSpecification(
  specificationInput: unknown,
  resultInput: VoiceSynthesisResult,
  placementInput: VoiceTrackPlacement,
): MotionSpecification {
  const specification = MotionSpecificationSchema.parse(specificationInput);
  const result = VoiceSynthesisResultSchema.parse(resultInput);
  const placement = VoiceTrackPlacementSchema.parse(placementInput);
  const audio = VoiceAudioReferenceSchema.parse(result.audio);
  const selection = VoiceSelectionSchema.parse(result.selectedVoice);

  if (specification.project.id !== result.projectId) {
    throw new Error("Voice result project ID does not match the Motion Specification.");
  }
  if (
    specification.audio.voiceSelection &&
    !sameVoiceIdentity(specification.audio.voiceSelection, selection) &&
    !placement.allowVoiceChange
  ) {
    throw new Error("Changing a project's pinned voice requires explicit confirmation.");
  }

  const assetId = chooseAssetId(specification, audio.id);
  const assetExists = specification.assets.some((asset) => asset.id === assetId);
  const assets = assetExists
    ? specification.assets
    : [...specification.assets, AssetSpecSchema.parse({
      id: assetId,
      name: "Generated narration",
      kind: "audio",
      source: audio.href,
      mimeType: audio.mimeType,
      licenseStatus: "generated",
    })];

  const track = AudioTrackSchema.parse({
    id: chooseTrackId(specification, audio.id),
    assetId,
    role: "voice",
    startFrame: placement.startFrame,
    durationInFrames: placement.durationInFrames,
    gain: placement.gain,
    fadeInFrames: placement.fadeInFrames,
    fadeOutFrames: placement.fadeOutFrames,
    voiceSelection: selection,
  });

  return MotionSpecificationSchema.parse({
    ...specification,
    assets,
    audio: {
      ...specification.audio,
      voiceSelection: selection,
      tracks: [...specification.audio.tracks, track],
    },
  });
}
