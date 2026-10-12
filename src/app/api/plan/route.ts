import { NextResponse } from "next/server";
import { createDirectorPlan } from "@/ai/director/plan-video";
import { DirectorRequestSchema } from "@/ai/director/request-schema";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const bodyText = await request.text();
  if (new TextEncoder().encode(bodyText).byteLength > 32_000) {
    return NextResponse.json({ error: "Request body exceeds the 32 KB Phase 1 limit." }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
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
