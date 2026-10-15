import { z } from "zod";

/**
 * MOTION_RULES — the single source of truth for the motion quality policy.
 *
 * The same data is rendered as:
 *   1. a prompt section appended to the existing generation prompt (`/api/generate`), and
 *   2. the issue-code vocabulary the visual critique must use (`src/agent/vision-critique.ts`).
 *
 * The rules are data only. They never contain executable code, and the repair loop only
 * ever applies them to the data-only `MotionSpecification` schema.
 */

export const MOTION_RULES_VERSION = "1.0.0";

export const MotionRuleCategorySchema = z.enum([
  "timing",
  "layout",
  "typography",
  "color",
  "motion",
  "content",
  "data-safety",
]);

export const MotionRuleSeveritySchema = z.enum(["critical", "major", "minor"]);

export const MotionRuleSchema = z.object({
  id: z
    .string()
    .min(3)
    .max(48)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Rule ids are lower-case kebab-case."),
  category: MotionRuleCategorySchema,
  severity: MotionRuleSeveritySchema,
  requirement: z.string().min(10).max(400),
  /** Whether a deterministic, data-only repair exists for this rule. */
  deterministicRepair: z.boolean(),
});

export type MotionRule = z.infer<typeof MotionRuleSchema>;

export const MOTION_RULES: readonly MotionRule[] = Object.freeze(
  [
    {
      id: "timing-frames-not-seconds",
      category: "timing",
      severity: "critical",
      requirement:
        "Drive every duration from frames. Compute seconds as frames / fps and never mix the two units in one expression.",
      deterministicRepair: false,
    },
    {
      id: "timing-readable-beat",
      category: "timing",
      severity: "major",
      requirement:
        "Give every text beat at least 1.2 seconds (1.2 * fps frames) on screen, and keep the last beat visible for at least 0.8 seconds.",
      deterministicRepair: true,
    },
    {
      id: "layout-safe-area",
      category: "layout",
      severity: "major",
      requirement:
        "Keep text and logos inside the safe area: xPercent between 4 and 96 and widthPercent at most 92, so no content is clipped at the edges.",
      deterministicRepair: true,
    },
    {
      id: "layout-single-focus",
      category: "layout",
      severity: "major",
      requirement:
        "One dominant idea per scene. If two layers compete at the same position with similar size, demote or remove one.",
      deterministicRepair: false,
    },
    {
      id: "typography-contrast",
      category: "typography",
      severity: "critical",
      requirement:
        "Text must reach a contrast ratio of at least 4.5:1 against the background it sits on. Use the composition background colour for the calculation.",
      deterministicRepair: true,
    },
    {
      id: "typography-arabic-rtl",
      category: "typography",
      severity: "major",
      requirement:
        "Arabic text uses direction rtl, an Arabic-capable font stack (Cairo, Tajawal, sans-serif), lineHeight of at least 1.4, and must not share an element with a Latin-only font.",
      deterministicRepair: true,
    },
    {
      id: "typography-minimum-size",
      category: "typography",
      severity: "minor",
      requirement:
        "Body copy is at least 24px at the composition's native resolution and titles are at least 40px, scaled proportionally for 1080px-wide canvases.",
      deterministicRepair: true,
    },
    {
      id: "color-palette-limit",
      category: "color",
      severity: "minor",
      requirement:
        "Use at most four brand colours per video and keep a single accent colour for emphasis.",
      deterministicRepair: false,
    },
    {
      id: "motion-easing-and-clamping",
      category: "motion",
      severity: "major",
      requirement:
        "Every interpolate() call passes { extrapolateLeft: \"clamp\", extrapolateRight: \"clamp\" }; entrances use spring() and linear progress uses interpolate().",
      deterministicRepair: false,
    },
    {
      id: "content-no-placeholders",
      category: "content",
      severity: "critical",
      requirement:
        "Every layer carries real, complete content. No \"...\", \"TODO\", lorem ipsum, or comment-only placeholders anywhere in the output.",
      deterministicRepair: false,
    },
    {
      id: "content-no-truncated-copy",
      category: "content",
      severity: "major",
      requirement:
        "Text must fit inside its declared box: keep lines under 42 characters for Arabic and under 56 for Latin, and raise heightPercent instead of shrinking the font below the minimum size.",
      deterministicRepair: false,
    },
    {
      id: "data-safety-no-code",
      category: "data-safety",
      severity: "critical",
      requirement:
        "Emit data-only motion specifications. Never emit executable code, shell commands, filesystem paths, credentials, or asset URLs other than the approved /assets/, /uploads/, managed voice-audio, or https:// sources.",
      deterministicRepair: false,
    },
    {
      id: "data-safety-assets-approved",
      category: "data-safety",
      severity: "critical",
      requirement:
        "Reference only assets that exist in the approved asset list. Never invent, download, or hotlink an asset at render time.",
      deterministicRepair: false,
    },
  ].map((rule) => MotionRuleSchema.parse(rule)),
) as readonly MotionRule[];

const MOTION_RULE_IDS: readonly string[] = Object.freeze(MOTION_RULES.map((rule) => rule.id));

export function getMotionRuleIds(): readonly string[] {
  return MOTION_RULE_IDS;
}

export function isKnownMotionRuleId(value: string): boolean {
  return MOTION_RULE_IDS.includes(value);
}

export function getMotionRulesBySeverity(severity: MotionRule["severity"]): MotionRule[] {
  return MOTION_RULES.filter((rule) => rule.severity === severity);
}

/**
 * Prompt section appended to the existing generation prompt. Keep it deterministic: the same
 * version string must produce the same text so cached prompts and logs stay comparable.
 */
export function getMotionRulesPromptSection(): string {
  const lines = MOTION_RULES.map(
    (rule) => `- [${rule.severity}] ${rule.id}: ${rule.requirement}`,
  );
  return [
    `## MOTION RULES v${MOTION_RULES_VERSION} (ENFORCED BY VISUAL QA)`,
    "",
    "These rules are checked after rendering by an automated visual review. A render that",
    "violates a critical rule is rejected, so satisfy them in the first attempt.",
    "",
    ...lines,
  ].join("\n");
}

/** Rubric handed to the vision provider. Issue codes must come from this list. */
export function getCritiqueRubricLines(): string[] {
  return MOTION_RULES.map((rule) => `${rule.id} [${rule.severity}] — ${rule.requirement}`);
}

/* ------------------------------------------------------------------ */
/* Colour maths used by the deterministic repair provider and by tests  */
/* ------------------------------------------------------------------ */

export function parseHexColor(value: string): { r: number; g: number; b: number } | undefined {
  const match = /^#([0-9A-Fa-f]{6})$/.exec(value.trim());
  if (!match) return undefined;
  const hex = match[1];
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function toLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: string): number {
  const parsed = parseHexColor(color);
  if (!parsed) throw new Error("relativeLuminance expects a six-digit hex colour.");
  return 0.2126 * toLinear(parsed.r) + 0.7152 * toLinear(parsed.g) + 0.0722 * toLinear(parsed.b);
}

/** WCAG 2.1 contrast ratio, rounded to two decimals. */
export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

export const MINIMUM_CONTRAST_RATIO = 4.5;
