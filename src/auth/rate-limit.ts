/**
 * Fixed-window rate limiting on an abstracted key (phase 3).
 *
 * The policy map is per route class; the identifier is the cookie-verified
 * username for user limits and the client IP for login/global limits. The
 * implementation is a process-local in-memory store for development and
 * single-instance self-hosting; the Phase 5 shared-state work swaps it for a
 * Redis-backed implementation behind the same function signature, so
 * multi-instance deployments get a real distributed limiter.
 *
 * Enforcement is skipped entirely when AUTH_ENABLED=0 (dev escape).
 */

export interface RatePolicy {
  readonly max: number;
  readonly windowMs: number;
}

export const RATE_POLICIES = {
  "ip-global": { max: 120, windowMs: 60_000 },
  "auth-login": { max: 5, windowMs: 300_000 },
  generate: { max: 10, windowMs: 60_000 },
  plan: { max: 30, windowMs: 60_000 },
  "voice-providers": { max: 30, windowMs: 60_000 },
  "voice-synthesize": { max: 10, windowMs: 60_000 },
  "voice-audio": { max: 60, windowMs: 60_000 },
  "agent-qa": { max: 5, windowMs: 300_000 },
  "lambda-render": { max: 5, windowMs: 60_000 },
  "lambda-progress": { max: 60, windowMs: 60_000 },
} as const satisfies Record<string, RatePolicy>;

export type RatePolicyName = keyof typeof RATE_POLICIES;

export function getRatePolicy(name: RatePolicyName): RatePolicy {
  return RATE_POLICIES[name];
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

const MAX_TRACKED_KEYS_PER_POLICY = 10_000;
const buckets = new Map<RatePolicyName, Map<string, { count: number; windowStart: number }>>();

function sweep(name: RatePolicyName, now: number): void {
  const policyBuckets = buckets.get(name);
  if (!policyBuckets || policyBuckets.size <= MAX_TRACKED_KEYS_PER_POLICY) return;
  const policy = RATE_POLICIES[name];
  for (const [key, bucket] of policyBuckets) {
    if (now - bucket.windowStart >= policy.windowMs) policyBuckets.delete(key);
  }
}

export function checkRateLimit(
  name: RatePolicyName,
  identifier: string,
  now: number = Date.now(),
): RateLimitResult {
  const policy = RATE_POLICIES[name];
  let policyBuckets = buckets.get(name);
  if (!policyBuckets) {
    policyBuckets = new Map();
    buckets.set(name, policyBuckets);
  }
  sweep(name, now);

  const existing = policyBuckets.get(identifier);
  if (!existing || now - existing.windowStart >= policy.windowMs) {
    policyBuckets.set(identifier, { count: 1, windowStart: now });
    return { allowed: true, remaining: policy.max - 1, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  if (existing.count <= policy.max) {
    return {
      allowed: true,
      remaining: policy.max - existing.count,
      retryAfterSeconds: 0,
    };
  }
  return {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: Math.max(1, Math.ceil((existing.windowStart + policy.windowMs - now) / 1000)),
  };
}

/** Test isolation only. */
export function __resetRateLimitsForTests(): void {
  buckets.clear();
}

/** Best-effort client IP (proxy-injected when deployed behind one). */
export function clientIpFromRequest(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || "unknown";
}
