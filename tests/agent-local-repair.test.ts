import { describe, expect, it } from "vitest";
import previewSpecification from "../templates/phase-one-preview.json";
import { getMotionRuleIds, contrastRatio, MINIMUM_CONTRAST_RATIO } from "@/agent/motion-rules";
import {
  applyLocalMotionRepairs,
  isLocallyRepairableRule,
  LOCAL_REPAIRABLE_RULE_IDS,
  MINIMUM_BODY_FONT_SIZE,
  MINIMUM_TEXT_BEAT_SECONDS,
  MINIMUM_TITLE_FONT_SIZE,
  SAFE_AREA_MAX_WIDTH_PERCENT,
} from "@/agent/local-repair-provider";
import { MotionSpecificationSchema, type MotionSpecification } from "@/motion/schemas/motion-specification";

function createSpecification(): MotionSpecification {
  return MotionSpecificationSchema.parse(structuredClone(previewSpecification)) as MotionSpecification;
}

function textLayer(specification: MotionSpecification, sceneIndex = 0, layerIndex = 0) {
  const layer = specification.scenes[sceneIndex].layers[layerIndex];
  if (layer.type !== "text") throw new Error("The fixture no longer starts with a text layer.");
  return layer;
}

describe("deterministic repair catalogue", () => {
  it("only claims rules that exist in the shared motion rule set", () => {
    for (const ruleId of LOCAL_REPAIRABLE_RULE_IDS) {
      expect(isLocallyRepairableRule(ruleId)).toBe(true);
      expect(getMotionRuleIds()).toContain(ruleId);
    }
    expect(isLocallyRepairableRule("content-no-placeholders")).toBe(false);
    expect(isLocallyRepairableRule("not-a-rule")).toBe(false);
  });
});

describe("safe-area repair", () => {
  it("clamps overflowing layers and leaves the caller's specification untouched", () => {
    const specification = createSpecification();
    const sceneId = specification.scenes[0].id;
    // Values stay inside the specification schema but outside the motion safe area.
    const layer = textLayer(specification);
    layer.layout.xPercent = 99;
    layer.layout.yPercent = 1;
    layer.layout.widthPercent = 99;
    layer.layout.heightPercent = 2;
    const original = structuredClone(specification);

    const outcome = applyLocalMotionRepairs(specification, [
      { code: "layout-safe-area", severity: "major", message: "Outside the safe area.", sceneId },
    ]);

    expect(outcome.appliedRuleIds).toEqual(["layout-safe-area"]);
    expect(outcome.unrepairableRuleIds).toEqual([]);
    expect(specification).toEqual(original);

    const repaired = textLayer(outcome.specification);
    expect(repaired.layout.xPercent).toBe(96);
    expect(repaired.layout.yPercent).toBe(4);
    expect(repaired.layout.widthPercent).toBe(SAFE_AREA_MAX_WIDTH_PERCENT);
    expect(repaired.layout.heightPercent).toBe(4);
    expect(MotionSpecificationSchema.safeParse(outcome.specification).success).toBe(true);
  });

  it("only touches the referenced scene when the issue names one", () => {
    const specification = createSpecification();
    textLayer(specification, 0).layout.xPercent = 99;
    textLayer(specification, 1).layout.xPercent = 99;

    const outcome = applyLocalMotionRepairs(specification, [
      {
        code: "layout-safe-area",
        severity: "major",
        message: "Outside the safe area.",
        sceneId: specification.scenes[1].id,
      },
    ]);

    expect(textLayer(outcome.specification, 0).layout.xPercent).toBe(99);
    expect(textLayer(outcome.specification, 1).layout.xPercent).toBe(96);
  });

  it("reports the rule as unrepairable when there was nothing to change", () => {
    const specification = createSpecification();
    for (const scene of specification.scenes) {
      for (const layer of scene.layers) {
        layer.layout.xPercent = 50;
        layer.layout.yPercent = 50;
        layer.layout.widthPercent = 50;
        layer.layout.heightPercent = 50;
      }
    }

    const outcome = applyLocalMotionRepairs(specification, [
      { code: "layout-safe-area", severity: "minor", message: "Looks close to the edge." },
    ]);

    expect(outcome.appliedRuleIds).toEqual([]);
    expect(outcome.unrepairableRuleIds).toEqual(["layout-safe-area"]);
  });
});

describe("typography and timing repairs", () => {
  it("raises contrast to the WCAG threshold using the layer or composition background", () => {
    const specification = createSpecification();
    specification.composition.backgroundColor = "#FAFAFA";
    const layer = textLayer(specification);
    layer.style.color = "#F0F0F0";
    layer.style.backgroundColor = undefined;

    const outcome = applyLocalMotionRepairs(specification, [
      { code: "typography-contrast", severity: "critical", message: "Unreadable text." },
    ]);

    expect(outcome.appliedRuleIds).toEqual(["typography-contrast"]);
    const repaired = textLayer(outcome.specification);
    expect(contrastRatio(repaired.style.color, "#FAFAFA")).toBeGreaterThanOrEqual(MINIMUM_CONTRAST_RATIO);
    expect(repaired.style.color).toBe("#101828");

    // A layer that paints its own background is judged against that background.
    const withPanel = createSpecification();
    const panelLayer = textLayer(withPanel);
    panelLayer.style.backgroundColor = "#101828";
    panelLayer.style.color = "#121212";
    const panelOutcome = applyLocalMotionRepairs(withPanel, [
      { code: "typography-contrast", severity: "major", message: "Unreadable text." },
    ]);
    expect(panelOutcome.appliedRuleIds).toEqual(["typography-contrast"]);
    expect(contrastRatio(textLayer(panelOutcome.specification).style.color, "#101828")).toBeGreaterThanOrEqual(
      MINIMUM_CONTRAST_RATIO,
    );
  });

  it("applies RTL direction and an Arabic-capable font stack", () => {
    const specification = createSpecification();
    const layer = textLayer(specification);
    layer.style.direction = "ltr";
    layer.style.fontFamily = "Arial, sans-serif";

    const outcome = applyLocalMotionRepairs(specification, [
      { code: "typography-arabic-rtl", severity: "major", message: "Arabic text is not RTL." },
    ]);

    expect(outcome.appliedRuleIds).toEqual(["typography-arabic-rtl"]);
    const repaired = textLayer(outcome.specification);
    expect(repaired.style.direction).toBe("rtl");
    expect(repaired.style.fontFamily).toMatch(/Cairo/);
  });

  it("leaves Latin-only projects alone and raises the minimum font size", () => {
    const latin = createSpecification();
    latin.project.language = "en";
    const latinLayer = textLayer(latin);
    latinLayer.content = "From idea to motion";
    latin.scenes[0].title = "Opening";
    latinLayer.style.direction = "ltr";

    const untouched = applyLocalMotionRepairs(latin, [
      {
        code: "typography-arabic-rtl",
        severity: "major",
        message: "Needs RTL.",
        sceneId: latin.scenes[0].id,
      },
    ]);
    expect(untouched.appliedRuleIds).toEqual([]);
    expect(textLayer(untouched.specification).style.direction).toBe("ltr");

    const small = createSpecification();
    textLayer(small).style.fontSize = 16;
    textLayer(small).style.weight = "normal";
    const bodyOutcome = applyLocalMotionRepairs(small, [
      { code: "typography-minimum-size", severity: "major", message: "Too small." },
    ]);
    expect(textLayer(bodyOutcome.specification).style.fontSize).toBe(MINIMUM_BODY_FONT_SIZE);

    const smallTitle = createSpecification();
    textLayer(smallTitle).style.fontSize = 30;
    textLayer(smallTitle).style.weight = "bold";
    const titleOutcome = applyLocalMotionRepairs(smallTitle, [
      { code: "typography-minimum-size", severity: "major", message: "Too small." },
    ]);
    expect(textLayer(titleOutcome.specification).style.fontSize).toBe(MINIMUM_TITLE_FONT_SIZE);
  });

  it("extends a short text beat without overrunning its scene", () => {
    const specification = createSpecification();
    const minimumFrames = Math.ceil(MINIMUM_TEXT_BEAT_SECONDS * specification.composition.fps);
    const layer = textLayer(specification);
    layer.startFrame = 0;
    layer.durationInFrames = 5;

    const outcome = applyLocalMotionRepairs(specification, [
      { code: "timing-readable-beat", severity: "major", message: "The beat is too short." },
    ]);
    expect(outcome.appliedRuleIds).toEqual(["timing-readable-beat"]);
    const repaired = textLayer(outcome.specification);
    expect(repaired.durationInFrames).toBe(minimumFrames);
    expect(repaired.durationInFrames).toBeLessThanOrEqual(specification.scenes[0].durationInFrames);

    // A layer that starts near the end of its scene cannot be extended beyond the scene.
    const cramped = createSpecification();
    const crampedLayer = textLayer(cramped);
    crampedLayer.startFrame = cramped.scenes[0].durationInFrames - 3;
    crampedLayer.durationInFrames = 3;
    const crampedOutcome = applyLocalMotionRepairs(cramped, [
      { code: "timing-readable-beat", severity: "major", message: "The beat is too short." },
    ]);
    const repairedCramped = textLayer(crampedOutcome.specification);
    expect(repairedCramped.durationInFrames).toBe(3);
  });
});

describe("repair bookkeeping", () => {
  it("separates repairable from unrepairable rules and deduplicates repeated codes", () => {
    const specification = createSpecification();
    textLayer(specification).layout.xPercent = 99;

    const outcome = applyLocalMotionRepairs(specification, [
      { code: "layout-safe-area", severity: "major", message: "Outside the safe area." },
      { code: "layout-safe-area", severity: "major", message: "Still outside the safe area." },
      { code: "content-no-placeholders", severity: "critical", message: "Lorem ipsum is visible." },
      { code: "made-up-rule", severity: "minor", message: "Unknown rule." },
    ]);

    expect(outcome.appliedRuleIds).toEqual(["layout-safe-area"]);
    expect(outcome.unrepairableRuleIds).toEqual(["content-no-placeholders", "made-up-rule"]);
  });

  it("never changes the project identity, canvas, or timing", () => {
    const specification = createSpecification();
    const layer = textLayer(specification);
    layer.layout.xPercent = 99;
    layer.style.color = "#FAFAFA";
    layer.style.fontSize = 12;
    layer.style.direction = "ltr";
    layer.durationInFrames = 5;
    specification.composition.backgroundColor = "#FEFEFE";

    const outcome = applyLocalMotionRepairs(specification, [
      { code: "layout-safe-area", severity: "major", message: "Outside the safe area." },
      { code: "typography-contrast", severity: "critical", message: "Unreadable." },
      { code: "typography-minimum-size", severity: "major", message: "Too small." },
      { code: "timing-readable-beat", severity: "major", message: "Too short." },
      { code: "typography-arabic-rtl", severity: "major", message: "Not RTL." },
    ]);

    expect(outcome.appliedRuleIds).toHaveLength(5);
    expect(outcome.specification.project).toEqual(specification.project);
    expect(outcome.specification.composition).toEqual(specification.composition);
    expect(outcome.specification.scenes.map((scene) => scene.id)).toEqual(
      specification.scenes.map((scene) => scene.id),
    );
    expect(outcome.specification.assets).toEqual(specification.assets);
  });
});
