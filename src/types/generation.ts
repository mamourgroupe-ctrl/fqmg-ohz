export const MODELS = [
  // ─── Ollama (Local) ───
  { id: "qwen2.5-coder:1.5b", name: "Qwen 2.5 Coder 1.5B (Local)" },
  {
    id: "hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M",
    name: "Qwen 2.5 Coder 7B Q4_K_M (Ollama Local)",
  },
  // ─── Anthropic (Official) ───
  { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5 (Anthropic)" },
  { id: "claude-opus-4-5-20250918",   name: "Claude Opus 4.5 (Anthropic)" },
  { id: "claude-haiku-4-5-20251001",  name: "Claude Haiku 4.5 (Anthropic)" },

  { id: "openrouter/free", name: "Auto (Free Router)" },
  { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B" },
  { id: "google/gemini-2.0-flash-exp", name: "Gemini 2.0 Flash" },
  { id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
  { id: "qwen/qwen-2.5-72b-instruct", name: "Qwen 2.5 72B" },
  { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet (Paid)" },
  { id: "openai/gpt-4o-mini", name: "GPT-4o Mini (Paid)" },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];

export type StreamPhase = "idle" | "reasoning" | "generating";

export type GenerationErrorType = "validation" | "api";

// ─── Aspect Ratios for Social Media ───
export const ASPECT_RATIOS = {
  "9:16": { width: 1080, height: 1920, label: "TikTok / Reels / Shorts (9:16)" },
  "1:1":  { width: 1080, height: 1080, label: "Instagram Feed (1:1)" },
  "4:5":  { width: 1080, height: 1350, label: "Instagram Portrait (4:5)" },
  "16:9": { width: 1920, height: 1080, label: "YouTube / Landscape (16:9)" },
} as const;

export type AspectRatioId = keyof typeof ASPECT_RATIOS;
export type AspectRatio = (typeof ASPECT_RATIOS)[AspectRatioId];