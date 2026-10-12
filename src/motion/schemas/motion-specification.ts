import { z } from "zod";
import { AspectRatioSchema, ASPECT_RATIO_PRESETS } from "@/render/presets/aspect-ratios";
import { VoiceSelectionSchema } from "@/voice/contracts/voice-contract";

const IdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Use letters, digits, hyphens, or underscores.");
const FrameSchema = z.number().int().nonnegative();
const PositiveFramesSchema = z.number().int().positive().max(108_000);
export const ColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Expected a six-digit hex color.");
const LanguageSchema = z.string().min(2).max(35);

function isSafeAssetSource(value: string): boolean {
  if (/^\/api\/voice\/audio\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return true;
  }

  if (value.startsWith("/assets/") || value.startsWith("/uploads/")) {
    return !value.includes("\\") && !value.split("/").includes("..");
  }

  if (value.startsWith("asset://")) {
    return (
      /^asset:\/\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
      !value.split("/").includes("..")
    );
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export const AssetSourceSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(isSafeAssetSource, {
    message: "Asset source must be HTTPS, /assets/, /uploads/, a managed voice-audio API reference, or asset://; executable and data URLs are not allowed.",
  });

export const MotionKeyframeSchema = z
  .object({
    property: z.enum([
      "xPercent",
      "yPercent",
      "scale",
      "rotation",
      "opacity",
      "fontSize",
      "text",
    ]),
    // Keyframe frames are local to the start of their layer.
    frame: FrameSchema,
    value: z.union([z.number().finite(), z.string().max(500)]),
    easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]).default("linear"),
  })
  .superRefine((keyframe, ctx) => {
    if (keyframe.property === "text" && typeof keyframe.value !== "string") {
      ctx.addIssue({ code: "custom", path: ["value"], message: "Text keyframes require a string value." });
    }

    if (keyframe.property !== "text" && typeof keyframe.value !== "number") {
      ctx.addIssue({ code: "custom", path: ["value"], message: "Numeric keyframes require a numeric value." });
    }
  });

export const LayerLayoutSchema = z.object({
  xPercent: z.number().min(0).max(100).default(50),
  yPercent: z.number().min(0).max(100).default(50),
  widthPercent: z.number().min(1).max(100).default(90),
  heightPercent: z.number().min(1).max(100).default(40),
});

const LayerBaseSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(120),
  startFrame: FrameSchema,
  durationInFrames: PositiveFramesSchema,
  opacity: z.number().min(0).max(1).default(1),
  layout: LayerLayoutSchema.default({
    xPercent: 50,
    yPercent: 50,
    widthPercent: 90,
    heightPercent: 40,
  }),
  keyframes: z.array(MotionKeyframeSchema).max(256).default([]),
});

const TextStyleSchema = z.object({
  fontFamily: z.string().min(1).max(120).default("Arial, sans-serif"),
  fontSize: z.number().min(8).max(256).default(64),
  color: ColorSchema.default("#FFFFFF"),
  alignment: z.enum(["left", "center", "right"]).default("center"),
  direction: z.enum(["rtl", "ltr", "auto"]).default("auto"),
  weight: z.enum(["normal", "bold"]).default("bold"),
  backgroundColor: ColorSchema.optional(),
});

const TextLayerSchema = LayerBaseSchema.extend({
  type: z.literal("text"),
  content: z.string().max(2_000),
  style: TextStyleSchema.default({
    fontFamily: "Arial, sans-serif",
    fontSize: 64,
    color: "#FFFFFF",
    alignment: "center",
    direction: "auto",
    weight: "bold",
  }),
});

const ImageLayerSchema = LayerBaseSchema.extend({
  type: z.literal("image"),
  assetId: IdSchema,
  alt: z.string().max(250).default(""),
  fit: z.enum(["cover", "contain"]).default("cover"),
});

const VideoLayerSchema = LayerBaseSchema.extend({
  type: z.literal("video"),
  assetId: IdSchema,
  fit: z.enum(["cover", "contain"]).default("cover"),
  muted: z.boolean().default(true),
});

const ShapeLayerSchema = LayerBaseSchema.extend({
  type: z.literal("shape"),
  shape: z.enum(["rectangle", "circle", "line"]),
  fillColor: ColorSchema.default("#FFFFFF"),
  strokeColor: ColorSchema.optional(),
  strokeWidth: z.number().min(0).max(64).default(0),
  cornerRadius: z.number().min(0).max(512).default(0),
});

export const MotionLayerSchema = z.discriminatedUnion("type", [
  TextLayerSchema,
  ImageLayerSchema,
  VideoLayerSchema,
  ShapeLayerSchema,
]);

export const SceneBeatSchema = z.enum([
  "hook",
  "problem",
  "solution",
  "benefits",
  "cta",
  "outro",
]);

export const SceneSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1).max(120),
    beat: SceneBeatSchema,
    startFrame: FrameSchema,
    durationInFrames: PositiveFramesSchema,
    transition: z
      .object({
        type: z.enum(["cut", "fade", "slide", "wipe"]),
        durationInFrames: FrameSchema,
      })
      .optional(),
    layers: z.array(MotionLayerSchema).max(200).default([]),
  })
  .superRefine((scene, ctx) => {
    if (scene.transition && scene.transition.durationInFrames > scene.durationInFrames) {
      ctx.addIssue({
        code: "custom",
        path: ["transition", "durationInFrames"],
        message: "A transition cannot be longer than its scene.",
      });
    }

    const keyframeIds = scene.layers.flatMap((layer, layerIndex) =>
      layer.keyframes.map((keyframe, keyframeIndex) => ({ layer, layerIndex, keyframe, keyframeIndex })),
    );

    for (const { layer, layerIndex, keyframe, keyframeIndex } of keyframeIds) {
      if (keyframe.frame >= layer.durationInFrames) {
        ctx.addIssue({
          code: "custom",
          path: ["layers", layerIndex, "keyframes", keyframeIndex, "frame"],
          message: "Keyframe frame must fall inside the layer duration.",
        });
      }
    }

    for (let layerIndex = 0; layerIndex < scene.layers.length; layerIndex += 1) {
      const layer = scene.layers[layerIndex];
      if (layer.startFrame + layer.durationInFrames > scene.durationInFrames) {
        ctx.addIssue({
          code: "custom",
          path: ["layers", layerIndex, "durationInFrames"],
          message: "Layer timing must fit inside its scene.",
        });
      }

      const keyframePositions = layer.keyframes.map((keyframe) => `${keyframe.property}:${keyframe.frame}`);
      if (new Set(keyframePositions).size !== keyframePositions.length) {
        ctx.addIssue({
          code: "custom",
          path: ["layers", layerIndex, "keyframes"],
          message: "A layer cannot define two keyframes for the same property at the same frame.",
        });
      }
    }
  });

const AssetBaseSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(180),
  source: AssetSourceSchema,
  mimeType: z.string().min(1).max(120).optional(),
  licenseStatus: z.enum(["user-provided", "licensed", "generated", "unknown"]).default("unknown"),
});

export const AssetSpecSchema = z.discriminatedUnion("kind", [
  AssetBaseSchema.extend({
    kind: z.literal("image"),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  }),
  AssetBaseSchema.extend({
    kind: z.literal("logo"),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  }),
  AssetBaseSchema.extend({
    kind: z.literal("video"),
    durationInFrames: PositiveFramesSchema.optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  }),
  AssetBaseSchema.extend({
    kind: z.literal("audio"),
    durationInFrames: PositiveFramesSchema.optional(),
  }),
  AssetBaseSchema.extend({ kind: z.literal("font") }),
]);

export const ProjectSpecSchema = z.object({
  id: IdSchema,
  title: z.string().min(1).max(160),
  prompt: z.string().min(1).max(4_000),
  videoKind: z.string().min(1).max(80),
  language: LanguageSchema,
  dialect: z.string().max(80).optional(),
  targetAudience: z.string().max(240).optional(),
  productOrService: z.string().max(240).optional(),
  visualStyle: z.string().max(240).optional(),
  createdAt: z.string().datetime().optional(),
});

export const CompositionSpecSchema = z
  .object({
    aspectRatio: AspectRatioSchema,
    width: z.number().int().positive().max(7_680),
    height: z.number().int().positive().max(7_680),
    fps: z.number().int().min(24).max(60),
    durationInFrames: PositiveFramesSchema,
    backgroundColor: ColorSchema.default("#101828"),
  })
  .superRefine((composition, ctx) => {
    const preset = ASPECT_RATIO_PRESETS[composition.aspectRatio];
    if (composition.width !== preset.width || composition.height !== preset.height) {
      ctx.addIssue({
        code: "custom",
        path: ["width"],
        message: `Dimensions for ${composition.aspectRatio} must be ${preset.width}×${preset.height}.`,
      });
    }
  });

export const AudioTrackSchema = z.object({
  id: IdSchema,
  assetId: IdSchema,
  role: z.enum(["voice", "music", "sound-effect"]),
  startFrame: FrameSchema,
  durationInFrames: PositiveFramesSchema,
  gain: z.number().min(0).max(2).default(1),
  fadeInFrames: FrameSchema.default(0),
  fadeOutFrames: FrameSchema.default(0),
  voiceSelection: VoiceSelectionSchema.optional(),
});

export const AudioSpecSchema = z.object({
  tracks: z.array(AudioTrackSchema).max(64).default([]),
  voiceSelection: VoiceSelectionSchema.optional(),
  masterVolume: z.number().min(0).max(1).default(1),
  normalize: z.boolean().default(false),
  ducking: z.boolean().default(false),
});

export const SubtitleWordSchema = z.object({
  text: z.string().min(1).max(120),
  // Word timing is absolute in the composition timeline.
  startFrame: FrameSchema,
  durationInFrames: PositiveFramesSchema,
});

export const SubtitleCueSchema = z.object({
  id: IdSchema,
  text: z.string().min(1).max(1_000),
  language: LanguageSchema,
  direction: z.enum(["rtl", "ltr", "auto"]),
  startFrame: FrameSchema,
  durationInFrames: PositiveFramesSchema,
  words: z.array(SubtitleWordSchema).max(250).default([]),
});

export const SubtitleSpecSchema = z.object({
  enabled: z.boolean().default(false),
  language: LanguageSchema.default("ar"),
  direction: z.enum(["rtl", "ltr", "auto"]).default("rtl"),
  style: z
    .object({
      fontFamily: z.string().min(1).max(120).default("Arial, sans-serif"),
      fontSize: z.number().min(8).max(160).default(48),
      color: ColorSchema.default("#FFFFFF"),
      backgroundColor: ColorSchema.default("#101828"),
      highlightColor: ColorSchema.default("#F28A45"),
      position: z.enum(["top", "center", "bottom"]).default("bottom"),
    })
    .default({
      fontFamily: "Arial, sans-serif",
      fontSize: 48,
      color: "#FFFFFF",
      backgroundColor: "#101828",
      highlightColor: "#F28A45",
      position: "bottom",
    }),
  cues: z.array(SubtitleCueSchema).max(5_000).default([]),
});

export const BrandSpecSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  logoAssetId: IdSchema.optional(),
  colors: z.array(ColorSchema).max(16).default([]),
  typography: z
    .object({
      headingFont: z.string().min(1).max(120).optional(),
      bodyFont: z.string().min(1).max(120).optional(),
    })
    .default({}),
  voiceTone: z.string().max(240).optional(),
  rules: z.array(z.string().min(1).max(500)).max(100).default([]),
});

export const RenderSpecSchema = z.object({
  engine: z.enum(["remotion", "adobe-after-effects", "adobe-premiere"]),
  outputFormat: z.enum(["mp4", "webm"]).default("mp4"),
  quality: z.enum(["preview", "standard", "high"]).default("standard"),
});

export const MotionSpecificationSchema = z
  .object({
    project: ProjectSpecSchema,
    composition: CompositionSpecSchema,
    scenes: z.array(SceneSchema).min(1).max(120),
    assets: z.array(AssetSpecSchema).max(500).default([]),
    audio: AudioSpecSchema.default({ tracks: [], masterVolume: 1, normalize: false, ducking: false }),
    subtitles: SubtitleSpecSchema.default({
      enabled: false,
      language: "ar",
      direction: "rtl",
      style: {
        fontFamily: "Arial, sans-serif",
        fontSize: 48,
        color: "#FFFFFF",
        backgroundColor: "#101828",
        highlightColor: "#F28A45",
        position: "bottom",
      },
      cues: [],
    }),
    branding: BrandSpecSchema.default({ colors: [], typography: {}, rules: [] }),
    render: RenderSpecSchema,
  })
  .superRefine((specification, ctx) => {
    const { durationInFrames } = specification.composition;
    const uniqueChecks: Array<{ label: string; ids: string[]; path: (string | number)[] }> = [
      { label: "scene", ids: specification.scenes.map((scene) => scene.id), path: ["scenes"] },
      { label: "asset", ids: specification.assets.map((asset) => asset.id), path: ["assets"] },
      { label: "audio track", ids: specification.audio.tracks.map((track) => track.id), path: ["audio", "tracks"] },
      { label: "subtitle cue", ids: specification.subtitles.cues.map((cue) => cue.id), path: ["subtitles", "cues"] },
    ];

    for (const check of uniqueChecks) {
      if (new Set(check.ids).size !== check.ids.length) {
        ctx.addIssue({
          code: "custom",
          path: check.path,
          message: `Every ${check.label} ID must be unique.`,
        });
      }
    }

    const allLayerIds = specification.scenes.flatMap((scene) => scene.layers.map((layer) => layer.id));
    if (new Set(allLayerIds).size !== allLayerIds.length) {
      ctx.addIssue({ code: "custom", path: ["scenes"], message: "Layer IDs must be unique across the project." });
    }

    for (let sceneIndex = 0; sceneIndex < specification.scenes.length; sceneIndex += 1) {
      const scene = specification.scenes[sceneIndex];
      if (scene.startFrame + scene.durationInFrames > durationInFrames) {
        ctx.addIssue({
          code: "custom",
          path: ["scenes", sceneIndex, "durationInFrames"],
          message: "Scene timing must fit inside the composition duration.",
        });
      }

      for (let layerIndex = 0; layerIndex < scene.layers.length; layerIndex += 1) {
        const layer = scene.layers[layerIndex];
        if (layer.type === "image" || layer.type === "video") {
          const assetIndex = specification.assets.findIndex((asset) => asset.id === layer.assetId);
          const asset = specification.assets[assetIndex];
          const validKind = layer.type === "image" ? asset?.kind === "image" || asset?.kind === "logo" : asset?.kind === "video";
          if (!validKind) {
            ctx.addIssue({
              code: "custom",
              path: ["scenes", sceneIndex, "layers", layerIndex, "assetId"],
              message: `${layer.type} layer must reference an existing ${layer.type === "image" ? "image or logo" : "video"} asset.`,
            });
          }
        }
      }
    }

    for (let trackIndex = 0; trackIndex < specification.audio.tracks.length; trackIndex += 1) {
      const track = specification.audio.tracks[trackIndex];
      const asset = specification.assets.find((candidate) => candidate.id === track.assetId);
      if (asset?.kind !== "audio" && asset?.kind !== "video") {
        ctx.addIssue({
          code: "custom",
          path: ["audio", "tracks", trackIndex, "assetId"],
          message: "Audio tracks must reference an existing audio or video asset.",
        });
      }
      if (track.startFrame + track.durationInFrames > durationInFrames) {
        ctx.addIssue({
          code: "custom",
          path: ["audio", "tracks", trackIndex, "durationInFrames"],
          message: "Audio track timing must fit inside the composition duration.",
        });
      }
      if (track.fadeInFrames + track.fadeOutFrames > track.durationInFrames) {
        ctx.addIssue({
          code: "custom",
          path: ["audio", "tracks", trackIndex],
          message: "Audio fades cannot exceed the track duration.",
        });
      }
    }

    for (let cueIndex = 0; cueIndex < specification.subtitles.cues.length; cueIndex += 1) {
      const cue = specification.subtitles.cues[cueIndex];
      const cueEnd = cue.startFrame + cue.durationInFrames;
      if (cueEnd > durationInFrames) {
        ctx.addIssue({
          code: "custom",
          path: ["subtitles", "cues", cueIndex, "durationInFrames"],
          message: "Subtitle cue timing must fit inside the composition duration.",
        });
      }

      for (let wordIndex = 0; wordIndex < cue.words.length; wordIndex += 1) {
        const word = cue.words[wordIndex];
        if (word.startFrame < cue.startFrame || word.startFrame + word.durationInFrames > cueEnd) {
          ctx.addIssue({
            code: "custom",
            path: ["subtitles", "cues", cueIndex, "words", wordIndex],
            message: "Word timing must fit inside its subtitle cue.",
          });
        }
      }
    }

    if (specification.branding.logoAssetId) {
      const logo = specification.assets.find((asset) => asset.id === specification.branding.logoAssetId);
      if (logo?.kind !== "logo" && logo?.kind !== "image") {
        ctx.addIssue({
          code: "custom",
          path: ["branding", "logoAssetId"],
          message: "Brand logo must reference an existing logo or image asset.",
        });
      }
    }
  });

export type MotionSpecification = z.infer<typeof MotionSpecificationSchema>;
export type MotionSpecificationInput = z.input<typeof MotionSpecificationSchema>;
export type MotionLayer = z.infer<typeof MotionLayerSchema>;
export type SceneSpec = z.infer<typeof SceneSchema>;
export type AssetSpec = z.infer<typeof AssetSpecSchema>;
export type SubtitleCue = z.infer<typeof SubtitleCueSchema>;
