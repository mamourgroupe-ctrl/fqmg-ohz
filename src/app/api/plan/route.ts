import { NextResponse } from "next/server";
import { createDirectorPlan } from "@/ai/director/plan-video";
import { DirectorRequestSchema } from "@/ai/director/request-schema";
import { readBoundedJson, VoiceRequestBodyError } from "@/voice/api/read-bounded-json";

export const runtime = "nodejs";

const PLAN_MAX_REQUEST_BYTES = 32 * 1024;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await readBoundedJson(request, PLAN_MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof VoiceRequestBodyError && error.kind === "too-large") {
      return NextResponse.json(
        { error: `Request body exceeds the ${Math.round(PLAN_MAX_REQUEST_BYTES / 1024)} KB limit.` },
        { status: 413 },
      );
    }
    if (error instanceof VoiceRequestBodyError && error.kind === "unsupported-content-type") {
      return NextResponse.json(
        { error: "Requests must use an application/json content type." },
        { status: 415 },
      );
    }
    return NextResponse.json(
      { error: "Request body must be valid UTF-8 JSON." },
      { status: 400 },
    );
  }

  const parsed = DirectorRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "The video brief did not pass validation.",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
      { status: 400 },
    );
  }

  try {
    const plan = await createDirectorPlan(parsed.data);
    return NextResponse.json(plan, { status: 200 });
  } catch {
    return NextResponse.json({ error: "The local planner could not create a validated motion plan." }, { status: 500 });
  }
}
