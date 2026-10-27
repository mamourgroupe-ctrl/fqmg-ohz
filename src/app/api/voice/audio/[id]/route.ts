import { NextResponse } from "next/server";
import { VoiceApiErrorSchema } from "@/voice/contracts/voice-contract";
import { getVoiceEngine } from "@/voice/runtime";
import { authenticateApiRequest, forbiddenResponse } from "@/auth/guard";
import { getAudioOwner } from "@/auth/ownership";
import { isAuthEnforced } from "@/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = authenticateApiRequest(_request, "voice-audio");
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  // Fail closed: a reference with no recorded owner (or owned by someone else)
  // is served to nobody (phase 3 ownership).
  if (isAuthEnforced()) {
    const owner = getAudioOwner(id);
    if (!owner || owner !== auth.user.username) {
      return forbiddenResponse("This audio belongs to another user or is unknown.");
    }
  }

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
