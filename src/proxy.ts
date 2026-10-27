import { NextResponse, type NextRequest } from "next/server";
import { isAuthEnforced, parseSessionCookie, verifySessionToken } from "@/auth/session";
import { checkRateLimit, clientIpFromRequest } from "@/auth/rate-limit";

/**
 * Outer gate for the API surface (phase 3). Next.js 16 renamed the middleware
 * convention to `proxy` (nodejs runtime by default) — see
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.
 *
 * The proxy is a fast, stateless first line: public endpoints pass, everything
 * else needs a verifiable session cookie, and the client IP is globally rate
 * limited (best-effort in-memory, per process). Route handlers still run
 * `authenticateApiRequest()` themselves — the handler gate is the real
 * boundary; the proxy never grants identity via headers.
 *
 * AUTH_ENABLED=0 (documented dev escape) disables this gate entirely.
 */

const PUBLIC_API_PATHS = new Set(["/api/auth/login", "/api/auth/logout"]);

function errorResponse(status: number, code: string, message: string, retryAfter?: string): NextResponse {
  return NextResponse.json(
    { error: { code, message, retryable: status === 429 } },
    { status, ...(retryAfter ? { headers: { "Retry-After": retryAfter } } : {}) },
  );
}

export default function proxy(request: NextRequest): NextResponse {
  const pathname = request.nextUrl.pathname;
  if (!pathname.startsWith("/api/")) return NextResponse.next();
  if (PUBLIC_API_PATHS.has(pathname)) return NextResponse.next();
  if (!isAuthEnforced()) return NextResponse.next();

  const ip = clientIpFromRequest(request);
  const ipLimit = checkRateLimit("ip-global", ip);
  if (!ipLimit.allowed) {
    return errorResponse(
      429,
      "RATE_LIMITED",
      "Too many requests from this address. Retry after the window passes.",
      String(ipLimit.retryAfterSeconds),
    );
  }

  const token = parseSessionCookie(request.headers.get("cookie"));
  const username = verifySessionToken(token ?? "", process.env.AUTH_SECRET?.trim());
  if (!username) {
    return errorResponse(401, "UNAUTHENTICATED", "Authentication required. Log in via POST /api/auth/login.");
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
