import path from "node:path";

/**
 * Error and log hygiene for the agent loop. Provider bodies, media-process output, and
 * filesystem paths are all untrusted: nothing leaves this module unredacted.
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]"],
  [/((?:api[_-]?key|apikey|token|secret|password|authorization)["']?\s*[=:]\s*)["']?[^\s"'&,;]+/gi, "$1[REDACTED]"],
  [/\bsk-(?:or-|proj-)?[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{12,}\b/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"],
  [/(https?:\/\/)[^/\s@]+:[^/\s@]+@/gi, "$1[REDACTED]@"],
  [/\b(xox[baprs]-)[A-Za-z0-9-]{6,}\b/gi, "$1[REDACTED]"],
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }

  // Redact literal environment values that look like credentials, longest first.
  const secrets = Object.entries(process.env)
    .filter(([name, value]) => Boolean(value) && /(API_KEY|TOKEN|SECRET|PASSWORD)/i.test(name))
    .map(([, value]) => value as string)
    .filter((value) => value.length >= 8)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    result = result.split(secret).join("[REDACTED]");
  }

  return result;
}

/**
 * Shortens any absolute filesystem path in diagnostic text to its basename.
 *
 * The negative lookbehind keeps URLs (`https://host/a/b`) intact while a real path such as
 * `/home/user/app/x.ts` becomes `x.ts`: internal layouts must not reach a log line or response.
 */
function shortenAbsolutePaths(text: string): string {
  return text
    .replace(
      /(^|[^\w:./-])((?:\/[\w.@+-]+)+\/?)/g,
      (_match, prefix: string, absolute: string) => `${prefix}${path.posix.basename(absolute)}`,
    )
    .replace(
      /(^|[^\w:./-])([A-Za-z]:\\(?:[\w.@+-]+\\?)+)/g,
      (_match, prefix: string, absolute: string) => {
        const base = absolute.split("\\").filter(Boolean).pop();
        return base ? `${prefix}${base}` : `${prefix}${absolute}`;
      },
    );
}

/** Collapses whitespace, redacts secrets, and shortens absolute paths to their basenames. */
export function sanitizeDiagnosticText(
  text: string,
  sensitivePaths: readonly string[] = [],
  maxLength = 240,
): string {
  let result = shortenAbsolutePaths(redactSecrets(text));
  for (const sensitivePath of sensitivePaths) {
    if (!sensitivePath) continue;
    const resolved = path.resolve(sensitivePath);
    result = result.split(resolved).join(path.basename(resolved));
    result = result.split(sensitivePath).join(path.basename(sensitivePath));
  }
  result = result.replace(/\s+/g, " ").trim();
  return result.length > maxLength ? `${result.slice(0, maxLength - 1)}…` : result;
}

/** Guard used before any text is written to logs or returned in an HTTP response. */
export function assertNoSecrets(text: string, secrets: readonly string[]): boolean {
  return secrets.every((secret) => secret.length === 0 || !text.includes(secret));
}
