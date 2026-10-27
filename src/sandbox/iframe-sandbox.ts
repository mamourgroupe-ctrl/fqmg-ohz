/**
 * Phase 4 — contract for the sandboxed preview iframe.
 *
 * The generated-component preview runs inside an iframe whose `sandbox`
 * attribute deliberately omits `allow-same-origin`, giving the frame an OPAQUE
 * origin: no cookies, no storage, no parent-DOM access, enforced by the
 * browser. All communication is structured postMessage (plain strings and
 * numbers only) validated on both ends. `SANDBOX_CSP` is served as a response
 * header for the frame route (next.config.js) and kills every network
 * channel (`connect-src 'none'`) — `unsafe-eval` stays confined to the opaque
 * realm and is the isolation feature, not a hole.
 */

export const SANDBOX_FRAME_SRC = "/preview-sandbox";

/** sandbox="allow-scripts" ONLY — never allow-same-origin, never top navigation. */
export const SANDBOX_SANDBOX_ATTRIBUTE = "allow-scripts";

/** Response header value for the frame route (see next.config.js). */
export const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

export interface SandboxFrameProps {
  src: string;
  sandbox: "allow-scripts";
  title: string;
  referrerPolicy: "no-referrer";
  allow: "";
}

export function buildSandboxFrameProps(): SandboxFrameProps {
  return {
    src: SANDBOX_FRAME_SRC,
    sandbox: "allow-scripts",
    title: "Sandboxed animation preview (isolated origin, no network)",
    referrerPolicy: "no-referrer",
    allow: "",
  };
}

export type SandboxMessage =
  | { type: "fqmg-sandbox/ready" }
  | { type: "fqmg-sandbox/error"; message: string }
  | { type: "fqmg-sandbox/meta"; durationInFrames: number; fps: number }
  | { type: "fqmg-sandbox/frame"; frame: number }
  | { type: "fqmg-sandbox/run"; transpiled: string; width: number; height: number; fps: number; durationInFrames: number }
  | { type: "fqmg-sandbox/capture-request"; frame: number; requestId: string }
  | { type: "fqmg-sandbox/capture-result"; requestId: string; dataUrl: string };

const HOSTILE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.keys(value).every((key) => !HOSTILE_KEYS.has(key));
}

function isFiniteInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2_000_000;
}

/**
 * Structural guard: only plain, structured-cloneable messages with known
 * types and exact field sets pass. Anything else — functions, unknown types,
 * hostile keys, wrong field types — is dropped.
 */
export function parseSandboxMessage(data: unknown): SandboxMessage | null {
  if (!isPlainObject(data)) return null;
  const type = data.type;
  if (typeof type !== "string" || !type.startsWith("fqmg-sandbox/")) return null;

  switch (type) {
    case "fqmg-sandbox/ready":
      return Object.keys(data).length === 1 ? { type } : null;
    case "fqmg-sandbox/error":
      return Object.keys(data).length === 2 && isNonEmptyString(data.message)
        ? { type, message: data.message }
        : null;
    case "fqmg-sandbox/meta":
      return Object.keys(data).length === 3 &&
        isFiniteInt(data.durationInFrames) &&
        data.durationInFrames > 0 &&
        isFiniteInt(data.fps) &&
        data.fps > 0
        ? { type, durationInFrames: data.durationInFrames, fps: data.fps }
        : null;
    case "fqmg-sandbox/frame":
      return Object.keys(data).length === 2 && isFiniteInt(data.frame) && data.frame >= 0
        ? { type, frame: data.frame }
        : null;
    case "fqmg-sandbox/run":
      return Object.keys(data).length === 6 &&
        isNonEmptyString(data.transpiled) &&
        isFiniteInt(data.width) && data.width > 0 &&
        isFiniteInt(data.height) && data.height > 0 &&
        isFiniteInt(data.fps) && data.fps > 0 &&
        isFiniteInt(data.durationInFrames) && data.durationInFrames > 0
        ? {
            type,
            transpiled: data.transpiled,
            width: data.width,
            height: data.height,
            fps: data.fps,
            durationInFrames: data.durationInFrames,
          }
        : null;
    case "fqmg-sandbox/capture-request":
      return Object.keys(data).length === 3 &&
        isFiniteInt(data.frame) &&
        data.frame >= 0 &&
        isNonEmptyString(data.requestId) &&
        data.requestId.length <= 128
        ? { type, frame: data.frame, requestId: data.requestId }
        : null;
    case "fqmg-sandbox/capture-result":
      return Object.keys(data).length === 3 &&
        isNonEmptyString(data.requestId) &&
        data.requestId.length <= 128 &&
        typeof data.dataUrl === "string" &&
        data.dataUrl.startsWith("data:image/") &&
        data.dataUrl.length <= 8_000_000
        ? { type, requestId: data.requestId, dataUrl: data.dataUrl }
        : null;
    default:
      return null;
  }
}

/**
 * An event is trusted only when it (1) comes from an OPAQUE origin — the
 * literal "null" is the only origin a sandboxed-without-allow-same-origin
 * frame can ever present — and (2) was sent by the exact frame window we
 * embedded, and (3) carries a structurally valid sandbox message.
 */
export function isTrustedSandboxEvent(
  event: { origin?: unknown; source?: unknown; data?: unknown },
  expectedSource: unknown,
): boolean {
  if (event.origin !== "null") return false;
  if (event.source !== expectedSource) return false;
  return parseSandboxMessage(event.data) !== null;
}
