import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Session authentication for the API surface (phase 3).
 *
 * Design (docs/decisions.md D-017):
 * - Identity comes ONLY from a signed session cookie issued by
 *   POST /api/auth/login. Client-controlled headers/body fields are never
 *   trusted as identity.
 * - Credentials are configured operators: FQMG_USERS="name:scrypt$salt$hash,..."
 *   (generate the hash with `npm run auth:hash -- "<password>"`).
 * - AUTH_ENABLED=0 is the explicit development escape; the default (unset) is
 *   ENFORCED everywhere — fail-closed.
 * - A missing/short AUTH_SECRET while enforced means nothing can be verified:
 *   every request is unauthenticated (401), never an implicit bypass.
 *
 * This module deliberately has the shape of an Auth.js boundary
 * (requireUser + signed session) so the implementation can be swapped later
 * without touching the routes.
 */

export const SESSION_COOKIE_NAME = "fqmg_session";
const MIN_SECRET_LENGTH = 32;
const SCRYPT_KEY_LENGTH = 64;

export class UnauthorizedError extends Error {
  constructor(message = "Authentication required.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export interface AuthedUser {
  username: string;
}

interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
}

let devEscapeWarned = false;

/** Auth is enforced unless explicitly disabled with AUTH_ENABLED=0. */
export function isAuthEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AUTH_ENABLED === "0") {
    if (!devEscapeWarned) {
      devEscapeWarned = true;
      console.warn(
        "[auth] AUTH_ENABLED=0: authentication, authorization, and rate limiting are DISABLED. Never run this mode on a public interface.",
      );
    }
    return false;
  }
  return true;
}

function getSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const secret = env.AUTH_SECRET?.trim();
  if (!secret || secret.length < MIN_SECRET_LENGTH) return undefined;
  return secret;
}

export function parseConfiguredUsers(
  env: NodeJS.ProcessEnv = process.env,
): Map<string, string> {
  const users = new Map<string, string>();
  for (const pair of (env.FQMG_USERS ?? "").split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;
    const username = trimmed.slice(0, separator).trim();
    const record = trimmed.slice(separator + 1).trim();
    if (username && record) users.set(username, record);
  }
  return users;
}

/** Returns "scrypt$<saltHex>$<hashHex>" for storage in FQMG_USERS. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Constant-time credential verification against a stored record. */
export function verifyPassword(password: string, record: string): boolean {
  const parts = record.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (salt.length === 0 || expected.length !== SCRYPT_KEY_LENGTH) return false;
  const actual = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  return timingSafeEqual(actual, expected);
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Issues "<base64url(payload)>.<hmac>" for one username. */
export function createSessionToken(username: string, ttlMs: number, secret: string): string {
  const now = Date.now();
  const payload: SessionPayload = { sub: username, iat: now, exp: now + ttlMs };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

/** Verifies signature and expiry; returns the username or undefined. */
export function verifySessionToken(token: string, secret: string | undefined): string | undefined {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return undefined;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  const expected = sign(parts[0], secret);
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Partial<SessionPayload>;
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return undefined;
    if (typeof payload.exp !== "number" || payload.exp <= Date.now()) return undefined;
    return payload.sub;
  } catch {
    return undefined;
  }
}

/** Reads only the session cookie value from the Cookie header. */
export function parseSessionCookie(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    if (pair.slice(0, separator).trim() === SESSION_COOKIE_NAME) {
      return pair.slice(separator + 1).trim();
    }
  }
  return undefined;
}

/**
 * The single identity gate for every API route. Returns the session user, or
 * throws UnauthorizedError. With AUTH_ENABLED=0 it returns a fixed "dev" user
 * so local development keeps working; ownership and rate-limit checks skip in
 * that mode as well.
 */
export function requireUser(request: Request, env: NodeJS.ProcessEnv = process.env): AuthedUser {
  if (!isAuthEnforced(env)) {
    return { username: "dev" };
  }
  const token = parseSessionCookie(request.headers.get("cookie"));
  const username = verifySessionToken(token ?? "", getSecret(env));
  if (!username) throw new UnauthorizedError();
  if (!parseConfiguredUsers(env).has(username)) {
    // The user existed when the cookie was issued but is gone: revoked.
    throw new UnauthorizedError();
  }
  return { username };
}
