export class VoiceRequestBodyError extends Error {
  constructor(readonly kind: "too-large" | "invalid-json" | "unreadable" | "unsupported-content-type") {
    super("Voice API request body could not be accepted.");
    this.name = "VoiceRequestBodyError";
  }
}

export async function readBoundedJson(request: Request, maximumBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (!contentType || !/^application\/(?:json|[a-z0-9.+-]+\+json)$/.test(contentType)) {
    throw new VoiceRequestBodyError("unsupported-content-type");
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new VoiceRequestBodyError("too-large");
  }

  if (!request.body) throw new VoiceRequestBodyError("invalid-json");
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new VoiceRequestBodyError("too-large");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof VoiceRequestBodyError) throw error;
    throw new VoiceRequestBodyError("unreadable");
  }

  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, totalBytes));
    return JSON.parse(decoded) as unknown;
  } catch {
    throw new VoiceRequestBodyError("invalid-json");
  }
}
