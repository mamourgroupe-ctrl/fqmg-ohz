import { describe, expect, it } from "vitest";
import { planScenes } from "@/ai/scene-planner/scene-planner";

describe("scene planner", () => {
  it("fills the complete 18-second timeline without gaps", () => {
    const scenes = planScenes({ durationInFrames: 18 * 30, fps: 30, language: "ar", aspectRatio: "9:16" });
    expect(scenes).toHaveLength(4);
    expect(scenes.reduce((sum, scene) => sum + scene.durationInFrames, 0)).toBe(540);
    expect(scenes[0].startFrame).toBe(0);
    for (let index = 1; index < scenes.length; index += 1) {
      expect(scenes[index].startFrame).toBe(scenes[index - 1].startFrame + scenes[index - 1].durationInFrames);
    }
    expect(scenes.every((scene) => scene.durationInFrames > 0)).toBe(true);
  });

  it("allocates at least one frame to every beat for short valid timelines", () => {
    const scenes = planScenes({ durationInFrames: 4, fps: 24, language: "en", aspectRatio: "1:1" });
    expect(scenes.map((scene) => scene.durationInFrames)).toEqual([1, 1, 1, 1]);
  });

  it("uses Arabic text layers with explicit RTL direction", () => {
    const scenes = planScenes({ durationInFrames: 540, fps: 30, language: "ar", aspectRatio: "9:16" });
    const firstLayer = scenes[0].layers[0];
    expect(firstLayer.type).toBe("text");
    if (firstLayer.type === "text") {
      expect(firstLayer.style.direction).toBe("rtl");
      expect(firstLayer.content).toContain("بداية");
    }
  });

  it("rejects durations that cannot fit all four narrative beats", () => {
    expect(() => planScenes({ durationInFrames: 3, fps: 30, language: "en", aspectRatio: "16:9" })).toThrow(RangeError);
  });
});
