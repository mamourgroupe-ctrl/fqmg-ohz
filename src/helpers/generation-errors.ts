export type GenerationStreamEvent = Record<string, unknown>;

const STREAM_ERROR_FALLBACK =
  "The AI provider ended the generation without a usable error message. Check its availability and configuration, then retry.";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getErrorText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const record = asRecord(value);
  if (typeof record?.message === "string" && record.message.trim()) {
    return record.message.trim();
  }
  if (typeof record?.errorText === "string" && record.errorText.trim()) {
    return record.errorText.trim();
  }
  return undefined;
}

export function parseGenerationStreamEvent(
  data: string,
): GenerationStreamEvent | null {
  if (data === "[DONE]") return null;

  const parsed: unknown = JSON.parse(data);
  const event = asRecord(parsed);
  if (!event) throw new Error("Invalid generation stream event.");
  return event;
}

export function getGenerationStreamErrorMessage(error: unknown): string {
  return getErrorText(error) ?? STREAM_ERROR_FALLBACK;
}

export function isTruncatedGenerationEvent(
  event: GenerationStreamEvent,
): boolean {
  return event.type === "finish" && event.finishReason === "length";
}

export function getGenerationHttpErrorMessage(
  payload: unknown,
  status: number,
): string {
  const error = asRecord(payload)?.error;
  return getErrorText(error) ?? `Generation request failed (HTTP ${status}).`;
}

export function getSafeProviderErrorMessage(error: unknown): string {
  const message = getErrorText(error) ?? "";
  const record = asRecord(error);
  if (
    record?.code === "MODEL_SELECTION_FAILED" &&
    typeof record.publicMessage === "string"
  ) {
    return record.publicMessage;
  }
  const rawStatus = record?.statusCode ?? record?.status;
  const status = typeof rawStatus === "number" ? rawStatus : undefined;

  if (status === 401 || status === 403 || /user not found/i.test(message)) {
    return `The AI provider rejected the configured account${status ? ` (HTTP ${status})` : ""}. Verify the provider endpoint, account access, and selected model.`;
  }
  if (status === 404) {
    return "The AI provider could not find the selected model or endpoint (HTTP 404). Verify the provider configuration.";
  }
  if (status) {
    return `The AI provider request failed (HTTP ${status}). Verify provider availability and configuration, then retry.`;
  }
  return "The AI provider could not complete generation. Check its availability and configuration, then retry.";
}