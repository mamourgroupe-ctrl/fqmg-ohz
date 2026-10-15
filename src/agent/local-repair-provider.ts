import {
  MINIMUM_CONTRAST_RATIO,
  contrastRatio,
} from "@/agent/motion-rules";
import {
  MotionSpecificationSchema,
  type MotionSpecification,
  type SceneSpec,
} from "@/motion/schemas/motion-specification";

/**
 * Deterministic, data-only repairs.
 *
 * Every repair is a bounded edit to the validated Motion Specification. Nothing here executes
 * generated code, touches the filesystem, or calls a provider, so a repair can never introduce
 * shell access, secret access, or an arbitrary path. Only issues whose rule has an unambiguous
 * deterministic fix are handled; anything else is reported as unrepairable and stops the loop
 * instead of burning another render.
 */

export type RepairIssueInput = {
  code: string;
  severity: "critical" | "major" | "minor";
  message: string;
  sceneId?: string;
};

export interface LocalRepairOutcome {
  specification: MotionSpecification;
  appliedRuleIds: string[];
  unrepairableRuleIds: string[];
}

export const LOCAL_REPAIRABLE_RULE_IDS = [
  "layout-safe-area",
  "typography-contrast",
  "typography-arabic-rtl",
  "typography-minimum-size",
  "timing-readable-beat",
] as const;

export const MINIMUM_BODY_FONT_SIZE = 24;
export const MINIMUM_TITLE_FONT_SIZE = 40;
export const MINIMUM_TEXT_BEAT_SECONDS = 1.2;
export const SAFE_AREA_MIN_PERCENT = 4;
export const SAFE_AREA_MAX_PERCENT = 96;
export const SAFE_AREA_MAX_WIDTH_PERCENT = 92;

const ARABIC_PATTERN = /[\u0600-\u06FF]/;
const LATIN_ONLY_FONT_PATTERN = /^Arial,\s*sans-serif$/i;
const ARABIC_FONT_STACK = "Cairo, Tajawal, sans-serif";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function targetScenes(
  specification: MotionSpecification,
  issues: readonly RepairIssueInput[],
): Set<string> | undefined {
  const sceneIds = new Set(
    issues.map((issue) => issue.sceneId).filter((sceneId): sceneId is string => Boolean(sceneId)),
  );
  if (sceneIds.size === 0) return undefined;
  return sceneIds;
}

function mapScenes(
  specification: MotionSpecification,
  sceneIds: Set<string> | undefined,
  mapper: (scene: SceneSpec) => void,
): void {
  for (const scene of specification.scenes) {
    if (sceneIds && !sceneIds.has(scene.id)) continue;
    mapper(scene);
  }
}

function repairSafeArea(
  specification: MotionSpecification,
  sceneIds: Set<string> | undefined,
): void {
  mapScenes(specification, sceneIds, (scene) => {
    for (const layer of scene.layers) {
      layer.layout.xPercent = clamp(
        layer.layout.xPercent,
        SAFE_AREA_MIN_PERCENT,
        SAFE_AREA_MAX_PERCENT,
      );
      layer.layout.yPercent = clamp(
        layer.layout.yPercent,
        SAFE_AREA_MIN_PERCENT,
        SAFE_AREA_MAX_PERCENT,
      );
      layer.layout.widthPercent = clamp(
        layer.layout.widthPercent,
        SAFE_AREA_MIN_PERCENT,
        SAFE_AREA_MAX_WIDTH_PERCENT,
      );
      layer.layout.heightPercent = clamp(
        layer.layout.heightPercent,
        SAFE_AREA_MIN_PERCENT,
        SAFE_AREA_MAX_WIDTH_PERCENT,
      );
    }
  });
}

function repairContrast(
  specification: MotionSpecification,
  sceneIds: Set<string> | undefined,
): void {
  const compositionBackground = specification.composition.backgroundColor;
  mapScenes(specification, sceneIds, (scene) => {
    for (const layer of scene.layers) {
      if (layer.type !== "text") continue;
      const background = layer.style.backgroundColor ?? compositionBackground;
      if (contrastRatio(layer.style.color, background) >= MINIMUM_CONTRAST_RATIO) continue;

      const candidates = ["#FFFFFF", "#101828"];
      const best = candidates
        .map((color) => ({ color, ratio: contrastRatio(color, background) }))
        .sort((left, right) => right.ratio - left.ratio)[0];
      layer.style.color = best.color;
    }
  });
}

function repairArabicTypography(
  specification: MotionSpecification,
  sceneIds: Set<string> | undefined,
): void {
  const projectIsArabic = specification.project.language.toLowerCase().startsWith("ar");
  mapScenes(specification, sceneIds, (scene) => {
    for (const layer of scene.layers) {
      if (layer.type !== "text") continue;
      const isArabicContent = ARABIC_PATTERN.test(layer.content) || ARABIC_PATTERN.test(scene.title);
      if (!projectIsArabic && !isArabicContent) continue;
      layer.style.direction = "rtl";
      if (LATIN_ONLY_FONT_PATTERN.test(layer.style.fontFamily)) {
        layer.style.fontFamily = ARABIC_FONT_STACK;
      }
    }
  });
}

function repairMinimumFontSize(
  specification: MotionSpecification,
  sceneIds: Set<string> | undefined,
): void {
  mapScenes(specification, sceneIds, (scene) => {
    for (const layer of scene.layers) {
      if (layer.type !== "text") continue;
      const minimum =
        layer.style.weight === "bold" ? MINIMUM_TITLE_FONT_SIZE : MINIMUM_BODY_FONT_SIZE;
      if (layer.style.fontSize < minimum) layer.style.fontSize = minimum;
    }
  });
}

function repairReadableBeat(
  specification: MotionSpecification,
  sceneIds: Set<string> | undefined,
): void {
  const minimumFrames = Math.ceil(MINIMUM_TEXT_BEAT_SECONDS * specification.composition.fps);
  mapScenes(specification, sceneIds, (scene) => {
    for (const layer of scene.layers) {
      if (layer.type !== "text") continue;
      const maximumDuration = scene.durationInFrames - layer.startFrame;
      if (maximumDuration <= 0) continue;
      const target = Math.min(maximumDuration, Math.max(layer.durationInFrames, minimumFrames));
      if (target > layer.durationInFrames) layer.durationInFrames = target;
    }
  });
}

const REPAIR_FUNCTIONS: Record<
  (typeof LOCAL_REPAIRABLE_RULE_IDS)[number],
  (specification: MotionSpecification, sceneIds: Set<string> | undefined) => void
> = {
  "layout-safe-area": repairSafeArea,
  "typography-contrast": repairContrast,
  "typography-arabic-rtl": repairArabicTypography,
  "typography-minimum-size": repairMinimumFontSize,
  "timing-readable-beat": repairReadableBeat,
};

export function isLocallyRepairableRule(ruleId: string): boolean {
  return (LOCAL_REPAIRABLE_RULE_IDS as readonly string[]).includes(ruleId);
}

/**
 * Applies the deterministic repairs for the reported issue codes.
 * Returns the repairable and unrepairable rule ids so the loop can decide whether another
 * render is worth starting.
 */
export function applyLocalMotionRepairs(
  specification: MotionSpecification,
  issues: readonly RepairIssueInput[],
): LocalRepairOutcome {
  const working = MotionSpecificationSchema.parse(
    structuredClone(specification),
  ) as MotionSpecification;

  const applied: string[] = [];
  const unrepairable: string[] = [];
  const handled = new Set<string>();

  for (const issue of issues) {
    if (handled.has(issue.code)) continue;
    handled.add(issue.code);

    if (!isLocallyRepairableRule(issue.code)) {
      unrepairable.push(issue.code);
      continue;
    }

    const sceneIds = targetScenes(working, issues.filter((entry) => entry.code === issue.code));
    const before = JSON.stringify(working);
    REPAIR_FUNCTIONS[issue.code as (typeof LOCAL_REPAIRABLE_RULE_IDS)[number]](
      working,
      sceneIds,
    );
    const after = JSON.stringify(working);

    if (before === after) {
      unrepairable.push(issue.code);
    } else {
      applied.push(issue.code);
    }
  }

  const validated = MotionSpecificationSchema.parse(working) as MotionSpecification;
  return { specification: validated, appliedRuleIds: applied, unrepairableRuleIds: unrepairable };
}
