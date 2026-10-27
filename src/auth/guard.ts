import { NextResponse } from "next/server";
import { requireUser, isAuthEnforced, UnauthorizedError, type AuthedUser } from "@/auth/session";
import { checkRateLimit, type RatePolicyName } from "@/auth/rate-limit";

/**
 * The one-liner every API route calls first (phase 3):
 * authenticate from the verified session cookie, then apply the route's
 * per-user rate policy. Returns either the user or a ready-to-send response.
 */

export type ApiAuthResult =
  | { ok: true; user: AuthedUser }
  | { ok: false; response: Response };

export function authenticateApiRequest(
  request: Request,
  ratePolicy?: RatePolicyName,
): ApiAuthResult {
  let user: AuthedUser;
  try {
    user = requireUser(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: {
              code: "UNAUTHENTICATED",
              message: "Authentication required. Log in via POST /api/auth/login.",
              retryable: false,
            },
          },
          { status: 401 },
        ),
      };
    }
    throw error;
  }

  // AUTH_ENABLED=0 (dev escape) disables rate limiting together with auth.
  if (ratePolicy && isAuthEnforced()) {
    const limit = checkRateLimit(ratePolicy, user.username);
    if (!limit.allowed) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: {
              code: "RATE_LIMITED",
              message: "Too many requests for this account. Retry after the window passes.",
              retryable: true,
            },
          },
          { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
        ),
      };
    }
  }

  return { ok: true, user };
}

export function forbiddenResponse(message = "This resource belongs to another user."): Response {
  return NextResponse.json(
    {
      error: {
        code: "FORBIDDEN",
        message,
        retryable: false,
      },
    },
    { status: 403 },
  );
}
