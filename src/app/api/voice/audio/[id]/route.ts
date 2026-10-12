import { NextResponse } from "next/server";
import { VoiceApiErrorSchema } from "@/voice/contracts/voice-contract";
import { getVoiceEngine } from "@/voice/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const audio = await getVoiceEngine().cache.readReference(id);
  if (!audio) {
    return NextResponse.json(VoiceApiErrorSchema.parse({
      error: {
        code: "AUDIO_NOT_FOUND",
        message: "Managed voice audio was not found.",
        retryable: false,
      },
    }), { status: 404 });
  }

  const body = new Uint8Array(audio.bytes.byteLength);
  body.set(audio.bytes);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": audio.mimeType,
      "Content-Length": String(audio.sizeBytes),
      "Content-Disposition": 'inline; filename="voice.mp3"',
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
