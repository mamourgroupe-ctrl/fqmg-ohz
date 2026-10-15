import type { VisionProvider, VisionProviderRequest } from "@/agent/vision-critique";
import { getVisionInstruction } from "@/agent/vision-critique";
import { redactSecrets, sanitizeDiagnosticText } from "@/agent/redaction";

/**
 * Vision provider adapters.
 *
 * Default state is DISABLED. No provider is contacted unless an operator explicitly enables one,
 * and the operator must confirm that the chosen model is documented to accept images. That
 * confirmation is a required argument, because this environment could not verify any provider's
 * image-input support against its official documentation (only GitHub, npm, and PyPI are
 * reachable here). Without that confirmation the factory throws instead of guessing.
 */

export const DISABLED_VISION_PROVIDER_ID = "disabled" as const;

/** Always reports "not configured"; used by default so no network call can happen. */
export function createDisabledVisionProvider(modelId = "unconfigured"): VisionProvider {
  return {
    id: DISABLED_VISION_PROVIDER_ID,
    modelId,
    isConfigured: false,
    async critique(): Promise<never> {
      throw new Error("The disabled vision provider must never be called.");
    },
  };
}

const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface OpenAiCompatibleVisionOptions {
  /** Provider id recorded in results and logs, for example "openai-compatible". */
  id: string;
  modelId: string;
  apiKey: string | undefined;
  baseUrl: string;
  /** curl-style: swapped in tests. Defaults to global fetch, so tests must not use the default. */
  fetcher?: typeof fetch;
  timeoutMs?: number;
  /**
   * Required acknowledgement that the operator verified image input support for `modelId`
   * against the provider's official documentation. There is no default.
   */
  imageSupportVerifiedByOperator: boolean;
  /** Optional: ask the endpoint for a JSON-only response when it documents that option. */
  requestJsonResponseFormat?: boolean;
}

/**
 * Minimal OpenAI-compatible chat-completions adapter. It sends data URLs for the frames and
 * returns the assistant message content verbatim; parsing and validation belong to
 * `vision-critique.ts`, which never trusts this text.
 */
export function createOpenAiCompatibleVisionProvider(
  options: OpenAiCompatibleVisionOptions,
): VisionProvider {
  if (!options.imageSupportVerifiedByOperator) {
    throw new Error(
      "Refusing to create a vision provider without explicit confirmation that the model accepts image input. Verify the provider's official documentation first.",
    );
  }

  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetcher = options.fetcher ?? fetch;

  return {
    id: options.id,
    modelId: options.modelId,
    isConfigured: Boolean(options.apiKey),

    async critique(request: VisionProviderRequest): Promise<unknown> {
      if (!options.apiKey) {
        throw new Error("The vision provider has no API key configured.");
      }

      const response = await fetcher(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        signal: request.signal,
        body: JSON.stringify({
          model: options.modelId,
          max_tokens: request.maxOutputTokens,
          temperature: 0,
          ...(options.requestJsonResponseFormat
            ? { response_format: { type: "json_object" } }
            : {}),
          messages: [
            { role: "system", content: getVisionInstruction() },
            {
              role: "user",
              content: [
                { type: "text", text: request.prompt },
                ...request.frames.map((frame) => ({
                  type: "image_url",
                  image_url: { url: frame.dataUrl },
                })),
              ],
            },
          ],
        }),
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`The vision provider answered HTTP ${response.status}.`);
      }

      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("The vision provider response exceeds the accepted size limit.");
      }

      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
        throw new Error("The vision provider response exceeds the accepted size limit.");
      }

      const body = JSON.parse(new TextDecoder().decode(bytes)) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = body.choices?.[0]?.message?.content;

      if (typeof content === "string") return content;

      if (Array.isArray(content)) {
        const text = content
          .map((part) =>
            part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
              ? (part as { text: string }).text
              : "",
          )
          .join("");
        if (text.trim()) return text;
      }

      throw new Error("The vision provider returned no assistant message content.");
    },
  };
}

/** Provider-facing redaction helper, exported so adapters never build unsanitized messages. */
export function safeProviderMessage(error: unknown): string {
  return sanitizeDiagnosticText(
    redactSecrets(error instanceof Error ? error.message : String(error)),
  );
}
