import { describe, expect, it } from "vitest";
import { audioTrackVolumeAt } from "@/render/remotion/audio-mix";

const baseTrack = {
  gain: 1,
  fadeInFrames: 0,
  fadeOutFrames: 0,
  durationInFrames: 30,
};

describe("audioTrackVolumeAt (phase 7 mixing math)", () => {
  it("keeps a constant gain x masterVolume when no fades are set", () => {
    expect(audioTrackVolumeAt(0, baseTrack, 0.9)).toBeCloseTo(0.9, 6);
    expect(audioTrackVolumeAt(29, baseTrack, 0.9)).toBeCloseTo(0.9, 6);
  });

  it("ramps linearly over fadeInFrames from silence", () => {
    const track = { ...baseTrack, fadeInFrames: 6 };
    expect(audioTrackVolumeAt(0, track, 1)).toBeCloseTo(0, 6);
    expect(audioTrackVolumeAt(3, track, 1)).toBeCloseTo(0.5, 6);
    expect(audioTrackVolumeAt(6, track, 1)).toBeCloseTo(1, 6);
    expect(audioTrackVolumeAt(10, track, 1)).toBeCloseTo(1, 6);
  });

  it("ramps linearly down over the last fadeOutFrames", () => {
    const track = { ...baseTrack, fadeOutFrames: 10, durationInFrames: 30 };
    expect(audioTrackVolumeAt(19, track, 1)).toBeCloseTo(1, 6);
    expect(audioTrackVolumeAt(20, track, 1)).toBeCloseTo(1, 6);
    expect(audioTrackVolumeAt(25, track, 1)).toBeCloseTo(0.5, 6);
    expect(audioTrackVolumeAt(29, track, 1)).toBeCloseTo(0.1, 6);
  });

  it("applies the fade envelope on top of gain x masterVolume", () => {
    const track = { gain: 0.8, fadeInFrames: 0, fadeOutFrames: 10, durationInFrames: 30 };
    expect(audioTrackVolumeAt(25, track, 0.5)).toBeCloseTo(0.8 * 0.5 * 0.5, 6);
  });

  it("never returns a negative volume and clamps outside the track", () => {
    const track = { gain: 0.5, fadeInFrames: 5, fadeOutFrames: 5, durationInFrames: 30 };
    expect(audioTrackVolumeAt(-3, track, 1)).toBe(0);
    expect(audioTrackVolumeAt(40, track, 1)).toBe(0);
    expect(audioTrackVolumeAt(0, { ...track, gain: 0 }, 1)).toBe(0);
  });
});
