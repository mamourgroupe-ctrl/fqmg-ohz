import { NextResponse } from "next/server";
import { z, ZodType } from "zod";
import { sanitizeDiagnosticText } from "@/agent/redaction";
import { readBoundedJson, VoiceRequestBodyError } from "@/voice/api/read-bounded-json";
import { authenticateApiRequest } from "@/auth/guard";
import type { RatePolicyName } from "@/auth/rate-limit";

export type ApiResponse<Res> =
  | {
      type: "error";
      message: string;
    }
  | {
      type: "success";
      data: Res;
    };

export interface ExecuteApiOptions {
  /** Hard cap for the request body in bytes (default 64 KB). */
  maxBodyBytes?: number;
  /** Per-user rate policy applied after authentication (phase 3). */
  ratePolicy?: RatePolicyName;
}

export const DEFAULT_API_BODY_BYTES = 64 * 1024;

/**
 * Shared handler wrapper for routes that answer with `ApiResponse` JSON
 * (currently the Lambda render/progress routes).
 *
 * Contract since phase 2 (docs/api-validation.md):
 * - the body is read through readBoundedJson: too large → 413, non-JSON
 *   content type → 415, malformed JSON → 400;
 * - a schema failure → 400 with structured `issues`, never the raw Zod report;
 * - a handler error → 500 with a generic message; the real error is logged
 *   internally through the shared redaction pipeline (secrets redacted,
 *   absolute paths shortened).
 */
export const executeApi =
  <Res, Req extends ZodType>(
    schema: Req,
    handler: (req: Request, body: z.infer<Req>) => Promise<Res>,
    options: ExecuteApiOptions = {},
  ) =>
  async (req: Request) => {
    const auth = authenticateApiRequest(req, options.ratePolicy);
    if (!auth.ok) return auth.response;

    const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_API_BODY_BYTES;

    let payload: unknown;
    try {
      payload = await readBoundedJson(req, maxBodyBytes);
    } catch (error) {
      if (error instanceof VoiceRequestBodyError) {
        if (error.kind === "too-large") {
          return NextResponse.json(
            {
              type: "error",
              message: `The request body exceeds the ${Math.round(maxBodyBytes / 1024)} KB limit.`,
            },
            { status: 413 },
          );
        }
        if (error.kind === "unsupported-content-type") {
          return NextResponse.json(
            { type: "error", message: "Requests must use an application/json content type." },
            { status: 415 },
          );
        }
        return NextResponse.json(
          { type: "error", message: "The request body must be valid UTF-8 JSON." },
          { status: 400 },
        );
      }
      throw error;
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      return NextResponse.json(
        {
          type: "error",
          message: "The request did not pass validation.",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    try {
      const data = await handler(req, parsed.data);
      return NextResponse.json({
        type: "success",
        data: data,
      });
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      console.error("[api] handler failed:", sanitizeDiagnosticText(rawMessage));
      return NextResponse.json(
        { type: "error", message: "Unexpected server error." },
        { status: 500 },
      );
    }
  };
