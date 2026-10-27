import { NextResponse } from "next/server";
import { z } from "zod";
import { readBoundedJson, VoiceRequestBodyError } from "@/voice/api/read-bounded-json";
import {
  createSessionToken,
  isAuthEnforced,
  parseConfiguredUsers,
  verifyPassword,
} from "@/auth/session";
import { checkRateLimit, clientIpFromRequest } from "@/auth/rate-limit";

export const runtime = "nodejs";

const MAX_LOGIN_REQUEST_BYTES = 8 * 1024;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const LoginRequestSchema = z.object({
  username: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(200),
});

function errorResponse(status: number, code: string, message: string, retryable = false): NextResponse {
  return NextResponse.json({ error: { code, message, retryable } }, { status });
}

/**
 * Issues a signed, HttpOnly session cookie for a configured operator.
 * Identity is never accepted from the request beyond these credentials; the
 * password record format is documented in .env.example (`scrypt$salt$hash`).
 * Login attempts are rate limited per client IP.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const ipLimit = checkRateLimit("auth-login", clientIpFromRequest(request));
  if (!ipLimit.allowed) {
    return errorResponse(
      429,
      "RATE_LIMITED",
      "Too many login attempts from this address. Retry after the window passes.",
      true,
    );
  }

  const configuredSecret = process.env.AUTH_SECRET?.trim();
  const secret = configuredSecret && configuredSecret.length >= 32 ? configuredSecret : undefined;
  if (!isAuthEnforced()) {
    return errorResponse(
      503,
      "AUTH_DISABLED",
      "Authentication is disabled (AUTH_ENABLED=0); there is nothing to log in to.",
    );
  }
  if (!secret) {
    return errorResponse(
      503,
      "AUTH_NOT_CONFIGURED",
      "Set AUTH_SECRET and FQMG_USERS to enable login.",
    );
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request, MAX_LOGIN_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof VoiceRequestBodyError && error.kind === "too-large") {
      return errorResponse(413, "INVALID_REQUEST", "The login body exceeds the 8 KB limit.");
    }
    if (error instanceof VoiceRequestBodyError && error.kind === "unsupported-content-type") {
      return errorResponse(415, "INVALID_REQUEST", "Login requests must use an application/json content type.");
    }
    return errorResponse(400, "INVALID_REQUEST", "The login body must be valid UTF-8 JSON.");
  }

  const parsed = LoginRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "INVALID_REQUEST", "Provide a username and a password.");
  }

  const record = parseConfiguredUsers().get(parsed.data.username);
  const valid = record ? verifyPassword(parsed.data.password, record) : false;
  if (!valid) {
    // Generic on purpose: no user enumeration.
    return errorResponse(401, "INVALID_CREDENTIALS", "Invalid username or password.");
  }

  const token = createSessionToken(parsed.data.username, SESSION_TTL_MS, secret);
  const response = NextResponse.json({ type: "success", user: { username: parsed.data.username } });
  response.cookies.set({
    name: "fqmg_session",
    value: token,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure: process.env.NODE_ENV === "production",
  });
  return response;
}
