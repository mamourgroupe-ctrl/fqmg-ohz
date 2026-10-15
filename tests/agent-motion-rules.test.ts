import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  getCritiqueRubricLines,
  getMotionRuleIds,
  getMotionRulesPromptSection,
  isKnownMotionRuleId,
  MINIMUM_CONTRAST_RATIO,
  MOTION_RULES,
  MOTION_RULES_VERSION,
  MotionRuleSchema,
  parseHexColor,
  relativeLuminance,
} from "@/agent/motion-rules";

describe("MOTION_RULES", () => {
  it("is a validated, unique, kebab-case rule set", () => {
    expect(MOTION_RULES.length).toBeGreaterThanOrEqual(10);
    for (const rule of MOTION_RULES) {
      expect(MotionRuleSchema.safeParse(rule).success).toBe(true);
      expect(rule.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
    const ids = MOTION_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getMotionRuleIds()).toEqual(ids);
  });

  it("covers every severity and the critical safety categories", () => {
    const severities = new Set(MOTION_RULES.map((rule) => rule.severity));
    expect(severities).toEqual(new Set(["critical", "major", "minor"]));
    const dataSafety = MOTION_RULES.filter((rule) => rule.category === "data-safety");
    expect(dataSafety.length).toBeGreaterThanOrEqual(2);
    expect(dataSafety.every((rule) => rule.severity === "critical")).toBe(true);
  });

  it("renders a deterministic prompt section that names every rule", () => {
    const section = getMotionRulesPromptSection();
    expect(section).toContain(`MOTION RULES v${MOTION_RULES_VERSION}`);
    for (const rule of MOTION_RULES) {
      expect(section).toContain(rule.id);
      expect(section).toContain(rule.requirement);
    }
    expect(getMotionRulesPromptSection()).toBe(section);
  });

  it("exposes the same rule set as the critique rubric", () => {
    const rubric = getCritiqueRubricLines();
    expect(rubric).toHaveLength(MOTION_RULES.length);
    for (const rule of MOTION_RULES) {
      expect(rubric.some((line) => line.startsWith(`${rule.id} [`))).toBe(true);
      expect(isKnownMotionRuleId(rule.id)).toBe(true);
    }
    expect(isKnownMotionRuleId("not-a-rule")).toBe(false);
  });

  it("computes WCAG contrast ratios for repair decisions and the 4.5:1 threshold", () => {
    expect(parseHexColor("#FFFFFF")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColor("#101828")).toEqual({ r: 16, g: 24, b: 40 });
    expect(parseHexColor("white")).toBeUndefined();
    expect(() => relativeLuminance("nope")).toThrow();

    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
    expect(contrastRatio("#101828", "#101828")).toBe(1);
    expect(contrastRatio("#FFFFFF", "#101828")).toBeGreaterThan(MINIMUM_CONTRAST_RATIO);
    expect(contrastRatio("#F28A45", "#FFEEDD")).toBeLessThan(MINIMUM_CONTRAST_RATIO);
    // Symmetric: the ratio does not depend on argument order.
    expect(contrastRatio("#F28A45", "#101828")).toBe(contrastRatio("#101828", "#F28A45"));
  });
});
