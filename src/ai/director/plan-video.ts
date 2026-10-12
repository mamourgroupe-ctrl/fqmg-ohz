import { randomUUID } from "node:crypto";
import { planScenes } from "@/ai/scene-planner/scene-planner";
import { MotionSpecificationSchema, type MotionSpecification } from "@/motion/schemas/motion-specification";
import { ASPECT_RATIO_PRESETS } from "@/render/presets/aspect-ratios";
import { LocalRulesDirectorProvider } from "./local-rules-provider";
import type { DirectorProvider } from "./director-provider";
import { DirectorRequestSchema, type DirectorRequest, type DirectorRequestInput } from "./request-schema";

export interface DirectorPlan {
  providerId: string;
  plan: {
    videoKind: string;
    durationSeconds: number;
    language: "ar" | "fr" | "en";
    dialect?: string;
    targetAudience: string;
    productOrService: string;
    visualStyle: string;
    aspectRatio: DirectorRequest["aspectRatio"];
    voice: Awaited<ReturnType<DirectorProvider["generateBrief"]>>["voice"];
    music: Awaited<ReturnType<DirectorProvider["generateBrief"]>>["music"];
    scenes: Array<{
      id: string;
      title: string;
      beat: string;
      startSeconds: number;
      durationSeconds: number;
    }>;
    requiredAssets: Awaited<ReturnType<DirectorProvider["generateBrief"]>>["requiredAssets"];
    branding: {
      name?: string;
      colors: string[];
      voiceTone?: string;
      rules: string[];
    };
    render: {
      engine: DirectorRequest["renderEngine"];
      width: number;
      height: number;
      fps: number;
      outputFormat: "mp4";
      status: "not-rendered";
    };
  };
  motionSpecification: MotionSpecification;
  notes: string[];
}

export async function createDirectorPlan(
  input: DirectorRequestInput,
  provider: DirectorProvider = new LocalRulesDirectorProvider(),
): Promise<DirectorPlan> {
  const request = DirectorRequestSchema.parse(input);
  const brief = await provider.generateBrief(request);
  const preset = ASPECT_RATIO_PRESETS[request.aspectRatio];
  const durationInFrames = request.durationSeconds * request.fps;
  const scenes = planScenes({
    durationInFrames,
    fps: request.fps,
    language: brief.language,
    aspectRatio: request.aspectRatio,
  });
  const brand = request.brand;

  const motionSpecification = MotionSpecificationSchema.parse({
    project: {
      id: `project-${randomUUID()}`,
      title: request.title ?? brand?.name ?? "FQMG-OHZ — New video",
      prompt: request.prompt,
      videoKind: brief.videoKind,
      language: brief.language,
      ...(brief.dialect ? { dialect: brief.dialect } : {}),
      targetAudience: brief.targetAudience,
      productOrService: brief.productOrService,
      visualStyle: brief.visualStyle,
      createdAt: new Date().toISOString(),
    },
    composition: {
      aspectRatio: request.aspectRatio,
      width: preset.width,
      height: preset.height,
      fps: request.fps,
      durationInFrames,
      backgroundColor: "#101828",
    },
    scenes,
    assets: [],
    audio: { tracks: [], masterVolume: 1, normalize: false, ducking: false },
    subtitles: {
      enabled: false,
      language: brief.language,
      direction: brief.language === "ar" ? "rtl" : "ltr",
      cues: [],
    },
    branding: {
      ...(brand?.name ? { name: brand.name } : {}),
      ...(brand?.colors ? { colors: brand.colors } : {}),
      typography: {
        ...(brand?.headingFont ? { headingFont: brand.headingFont } : {}),
        ...(brand?.bodyFont ? { bodyFont: brand.bodyFont } : {}),
      },
      ...(brand?.voiceTone ? { voiceTone: brand.voiceTone } : {}),
      rules: brand?.rules ?? [],
    },
    render: {
      engine: request.renderEngine,
      outputFormat: "mp4",
      quality: "standard",
    },
  });

  return {
    providerId: provider.id,
    plan: {
      videoKind: brief.videoKind,
      durationSeconds: request.durationSeconds,
      language: brief.language,
      ...(brief.dialect ? { dialect: brief.dialect } : {}),
      targetAudience: brief.targetAudience,
      productOrService: brief.productOrService,
      visualStyle: brief.visualStyle,
      aspectRatio: request.aspectRatio,
      voice: brief.voice,
      music: brief.music,
      scenes: motionSpecification.scenes.map((scene) => ({
        id: scene.id,
        title: scene.title,
        beat: scene.beat,
        startSeconds: scene.startFrame / request.fps,
        durationSeconds: scene.durationInFrames / request.fps,
      })),
      requiredAssets: brief.requiredAssets,
      branding: {
        ...(brand?.name ? { name: brand.name } : {}),
        colors: brand?.colors ?? [],
        ...(brand?.voiceTone ? { voiceTone: brand.voiceTone } : {}),
        rules: brand?.rules ?? [],
      },
      render: {
        engine: request.renderEngine,
        width: preset.width,
        height: preset.height,
        fps: request.fps,
        outputFormat: "mp4",
        status: "not-rendered",
      },
    },
    motionSpecification,
    notes: [
      `Planning provider: ${provider.id}. No external AI provider was called.`,
      "Voice is planned only; no TTS provider is configured or invoked.",
      "No assets were created or downloaded; provide licensed/user-owned assets in a later phase.",
      "No render job was started and no output video file was produced.",
    ],
  };
}
