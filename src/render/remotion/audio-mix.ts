import type { MotionSpecification } from "@/motion/schemas/motion-specification";

type AudioTrack = MotionSpecification["audio"]["tracks"][number];

/**
 * Pure mixing math for one audio track at one composition frame (phase 7).
 *
 * The frame index is LOCAL to the track start. The returned value is the
 * amplitude multiplier Remotion applies for that frame: the track gain times
 * the project master volume, shaped by a linear fade-in over the first
 * `fadeInFrames` frames and a linear fade-out over the last `fadeOutFrames`
 * frames. Values are clamped at zero; gain up to 2 (schema bound) may
 * deliberately amplify above 1.
 */
export function audioTrackVolumeAt(
  localFrame: number,
  track: Pick<AudioTrack, "gain" | "fadeInFrames" | "fadeOutFrames" | "durationInFrames">,
  masterVolume: number,
): number {
  if (localFrame < 0 || localFrame >= track.durationInFrames) {
    return 0;
  }

  let envelope = 1;
  if (track.fadeInFrames > 0 && localFrame < track.fadeInFrames) {
    envelope = localFrame / track.fadeInFrames;
  }

  const fadeOutStart = track.durationInFrames - track.fadeOutFrames;
  if (track.fadeOutFrames > 0 && localFrame >= fadeOutStart) {
    const remaining = track.durationInFrames - localFrame;
    envelope = Math.min(envelope, remaining / track.fadeOutFrames);
  }

  return Math.max(0, track.gain * masterVolume * envelope);
}
