import { MotionComposition } from "@/render/remotion/MotionComposition";

// Phase 6 unified surface: the official composition is the data-only
// FQMG-OHZ-Preview registered by src/remotion/entry.tsx. This module is a
// plain re-export (no second registerRoot) and the legacy DynamicComp bundle
// is deleted.
export { MotionComposition };
export type { MotionCompositionProps } from "@/render/remotion/MotionComposition";
void MotionComposition;
