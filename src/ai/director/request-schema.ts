import { z } from "zod";
import { AspectRatioSchema } from "@/render/presets/aspect-ratios";
import { ColorSchema } from "@/motion/schemas/motion-specification";

export const BrandInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  colors: z.array(ColorSchema).max(16).default([]),
  headingFont: z.string().trim().min(1).max(120).optional(),
  bodyFont: z.string().trim().min(1).max(120).optional(),
  voiceTone: z.string().trim().max(240).optional(),
  rules: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
});

export const DirectorRequestSchema = z.object({
  prompt: z.string().trim().min(3).max(4_000),
  title: z.string().trim().min(1).max(160).optional(),
  durationSeconds: z.number().int().min(2).max(180).default(18),
  aspectRatio: AspectRatioSchema.default("9:16"),
  language: z.enum(["ar", "fr", "en"]).optional(),
  dialect: z.string().trim().min(1).max(80).optional(),
  targetAudience: z.string().trim().min(1).max(240).optional(),
  productOrService: z.string().trim().min(1).max(240).optional(),
  visualStyle: z.string().trim().min(1).max(240).optional(),
  voiceGender: z.enum(["feminine", "masculine", "unspecified"]).default("unspecified"),
  brand: BrandInputSchema.optional(),
  renderEngine: z.enum(["remotion", "adobe-after-effects", "adobe-premiere"]).default("remotion"),
  fps: z.number().int().min(24).max(60).default(30),
});

export type DirectorRequest = z.infer<typeof DirectorRequestSchema>;
export type DirectorRequestInput = z.input<typeof DirectorRequestSchema>;
export type BrandInput = z.infer<typeof BrandInputSchema>;
