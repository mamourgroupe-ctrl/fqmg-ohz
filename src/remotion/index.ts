import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

// The Phase 1 data-only composition (moved here from fqmg-ohz-next/src/remotion/index.ts
// when the two projects were merged). Keeping the re-export preserves the `@/remotion`
// surface next to the code-generation entry point registered below.
export { MotionComposition } from "@/render/remotion/MotionComposition";
export type { MotionCompositionProps } from "@/render/remotion/MotionComposition";

registerRoot(RemotionRoot);
