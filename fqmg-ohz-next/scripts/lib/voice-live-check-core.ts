/**
 * Live voice check for the Phase 2 Azure adapter.
 *
 * The exported pure helpers are unit-tested. A passing run is evidence only when an operator runs
 * it against a real provider with real credentials; the unit tests and the mocked flow tests are
 * not provider proof. Nothing here logs secret values, request headers, or full request configs.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { getFfprobeExecutable } from "@/render/engine/render-job";
import { VoiceSynthesisRequestSchema, type VoiceProfile, type VoiceProviderId } from "@/voice/contracts/voice-contract";
import { AzureSpeechAdapter, getAzureEndpoint, type AzureEndpoint } from "@/voice/providers/azure-speech";
import { VoiceProviderError, type VoiceProviderEnvironment } from "@/voice/providers/provider";

export const LIVE_CHECK_SCHEMA_VERSION = 1;
export const LIVE_CHECK_PROVIDER_ID: VoiceProviderId = "azure-speech";
export const DEFAULT_LIVE_PROVIDER = "azure";
export const ALGERIAN_LOCALE = "ar-DZ";
export const LIVE_CHECK_PROJECT_ID = "voice-live-check";
/** Neutral Modern Standard Arabic. This sentence checks that the voice speaks Arabic, not a dialect. */
export const LIVE_CHECK_SYNTHESIS_TEXT = "مرحبا بكم. هذا اختبار قصير للصوت العربي.";
/** Short text for the auth probes, which spend as little speech quota as possible. */
export const LIVE_CHECK_PROBE_TEXT = "مرحبا";
export const LIVE_CHECK_TIMEOUT_MS = 30_000;
export const LIVE_CHECK_OUTPUT_FORMAT = "audio-24khz-160kbitrate-mono-mp3";
export const LIVE_CHECK_USER_AGENT = "fqmg-ohz-next-voice-live-check";
export const SUMMARY_FILE_NAME = "summary.json";
export const INVENTORY_FILE_NAME = "inventory.json";
export const REDACTED_MARKER = "[REDACTED]";

const ISSUE_TOKEN_PATH = "/sts/v1.0/issueToken";
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{20,8192}$/;
const REGION_LABEL_PATTERN = /^[a-z0-9-]{3,32}$/;
/** Azure keys are 32 hex characters. No Azure region name has this shape, so it is treated as a misplaced key. */
const KEY_SHAPED_PATTERN = /^[0-9a-f]{32}$/i;
const FFPROBE_TIMEOUT_MS = 20_000;
const FFPROBE_MAX_OUTPUT_BYTES = 1_048_576;

const NOT_VERIFIED_BY_THIS_CHECK = [
  "Accent, dialect, and pronunciation: a person must listen to the saved audio.",
  "Algerian status: based only on the ar-DZ locale tag that the provider inventory returns.",
  "Audio quality beyond the ffprobe container, codec, duration, and sample-rate checks.",
  "Other providers (ElevenLabs, Google Cloud, OpenAI) were not checked.",
];

const HEADER_LABELS = {
  "ocp-apim-subscription-key": "Ocp-Apim-Subscription-Key",
  "authorization-bearer": "Authorization: Bearer",
} as const;

export type ProbeHeader = keyof typeof HEADER_LABELS;

export type ProbeOutcome =
  | "accepted"
  | "rejected-authentication"
  | "rejected-request"
  | "rate-limited"
  | "service-unavailable"
  | "unexpected-status"
  | "invalid-token-response"
  | "timeout"
  | "network-error"
  | "not-run";

export class LiveCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveCheckError";
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; not provider proof)
// ---------------------------------------------------------------------------

export type LiveProviderResolution =
  | { ok: true; providerId: VoiceProviderId }
  | { ok: false; message: string };

/** Accepts only Azure. The raw value is never echoed, so a mistyped secret cannot reach logs. */
export function resolveLiveProvider(rawValue: string | undefined): LiveProviderResolution {
  const selector = (rawValue ?? "").trim().toLowerCase() || DEFAULT_LIVE_PROVIDER;
  if (selector === "azure" || selector === "azure-speech") {
    return { ok: true, providerId: LIVE_CHECK_PROVIDER_ID };
  }
  return { ok: false, message: "VOICE_PROVIDER has an unsupported value. This check supports only: azure." };
}

export interface AzureEnvironmentStatus {
  /** Presence only. Values are never copied into this object. */
  presence: { AZURE_SPEECH_KEY: boolean; AZURE_SPEECH_REGION: boolean; AZURE_SPEECH_ENDPOINT: boolean };
  missing: string[];
}

function isPresent(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

export function getAzureEnvironmentStatus(environment: VoiceProviderEnvironment): AzureEnvironmentStatus {
  const presence = {
    AZURE_SPEECH_KEY: isPresent(environment.AZURE_SPEECH_KEY),
    AZURE_SPEECH_REGION: isPresent(environment.AZURE_SPEECH_REGION),
    AZURE_SPEECH_ENDPOINT: isPresent(environment.AZURE_SPEECH_ENDPOINT),
  };
  const missing: string[] = [];
  if (!presence.AZURE_SPEECH_KEY) missing.push("AZURE_SPEECH_KEY");
  if (!presence.AZURE_SPEECH_REGION && !presence.AZURE_SPEECH_ENDPOINT) {
    missing.push("AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT");
  }
  return { presence, missing };
}

/** Matches any ar-* tag, such as ar-SA, ar-EG, or a bare ar. */
export function isArabicLocale(tag: string): boolean {
  return tag.trim().split("-")[0].toLowerCase() === "ar";
}

/** Exact match on ar-DZ only. ar-SA, ar-EG, and MSA are not Algerian. */
export function isAlgerianLocale(tag: string): boolean {
  return tag.trim().toLowerCase() === ALGERIAN_LOCALE.toLowerCase();
}

export interface InventoryVoice {
  voiceId: string;
  displayName?: string;
  localeTags: readonly string[];
}

export interface ArabicLocaleCount {
  locale: string;
  voiceCount: number;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function summarizeArabicLocales(voices: readonly InventoryVoice[]): ArabicLocaleCount[] {
  const byLocale = new Map<string, { locale: string; voiceIds: Set<string> }>();
  for (const voice of voices) {
    for (const tag of new Set(voice.localeTags)) {
      if (!isArabicLocale(tag)) continue;
      const key = tag.trim().toLowerCase();
      const entry = byLocale.get(key) ?? { locale: tag.trim(), voiceIds: new Set<string>() };
      entry.voiceIds.add(voice.voiceId);
      byLocale.set(key, entry);
    }
  }
  return [...byLocale.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, entry]) => ({ locale: entry.locale, voiceCount: entry.voiceIds.size }));
}

export function findAlgerianVoices<T extends InventoryVoice>(voices: readonly T[]): T[] {
  return voices.filter((voice) => voice.localeTags.some(isAlgerianLocale));
}

export interface SynthesisSelection<T extends InventoryVoice> {
  voice: T;
  locale: string;
  algerianLocale: boolean;
}

/**
 * Prefers an ar-DZ voice (dedicated voices first, then multilingual voices that list ar-DZ).
 * Falls back to the first other Arabic voice only when no ar-DZ voice exists; the caller must label it NOT Algerian.
 */
export function selectSynthesisVoice<T extends InventoryVoice>(voices: readonly T[]): SynthesisSelection<T> | undefined {
  const sorted = [...voices].sort((left, right) => compareStrings(left.voiceId, right.voiceId));
  const algerianVoices = sorted.filter((voice) => voice.localeTags.some(isAlgerianLocale));
  const primaryAlgerian = algerianVoices.find((voice) => isAlgerianLocale(voice.localeTags[0] ?? ""));
  const algerianVoice = primaryAlgerian ?? algerianVoices[0];
  if (algerianVoice) {
    return { voice: algerianVoice, locale: ALGERIAN_LOCALE, algerianLocale: true };
  }
  for (const voice of sorted) {
    const arabicTag = voice.localeTags.find(isArabicLocale);
    if (arabicTag) return { voice, locale: arabicTag.trim(), algerianLocale: false };
  }
  return undefined;
}

export interface InventorySummary {
  voiceCount: number;
  arabicLocales: ArabicLocaleCount[];
  arabicVoiceIds: string[];
  algerianLocaleReturned: boolean;
  algerianVoices: Array<{ voiceId: string; displayName?: string; localeTags: string[] }>;
}

export function summarizeInventory(voices: readonly InventoryVoice[]): InventorySummary {
  const algerianVoices = findAlgerianVoices(voices).map((voice) => ({
    voiceId: voice.voiceId,
    displayName: voice.displayName,
    localeTags: [...voice.localeTags],
  }));
  return {
    voiceCount: voices.length,
    arabicLocales: summarizeArabicLocales(voices),
    arabicVoiceIds: voices
      .filter((voice) => voice.localeTags.some(isArabicLocale))
      .map((voice) => voice.voiceId)
      .sort(compareStrings),
    algerianLocaleReturned: algerianVoices.length > 0,
    algerianVoices,
  };
}

/** Replaces every occurrence of each secret. Longer secrets go first so overlaps are fully removed. */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | undefined>): string {
  const values = [...new Set(secrets.map((secret) => secret?.trim() ?? ""))]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);
  return values.reduce((redacted, secret) => redacted.split(secret).join(REDACTED_MARKER), text);
}

export function classifyHttpStatus(status: number): ProbeOutcome {
  if (status >= 200 && status <= 299) return "accepted";
  if (status === 401 || status === 403) return "rejected-authentication";
  if (status === 429) return "rate-limited";
  if (status >= 500 && status <= 599) return "service-unavailable";
  if (status >= 400 && status <= 499) return "rejected-request";
  return "unexpected-status";
}

export interface AzureRoutes {
  voicesList: string;
  synthesis: string;
  /** Resource endpoints only: the path shown in Microsoft's REST sample, probed for comparison. */
  alternateSynthesis?: string;
}

/** Paths mirror the adapter. The alternate synthesis path is probed only to test the documentation conflict. */
export function getAzureRoutes(kind: AzureEndpoint["kind"]): AzureRoutes {
  if (kind === "resource") {
    return {
      voicesList: "/tts/cognitiveservices/voices/list",
      synthesis: "/tts/cognitiveservices/v1",
      alternateSynthesis: "/cognitiveservices/v1",
    };
  }
  return { voicesList: "/cognitiveservices/voices/list", synthesis: "/cognitiveservices/v1" };
}

function regionFromRegionalOrigin(origin: string): string | undefined {
  const label = new URL(origin).hostname.split(".")[0] ?? "";
  return REGION_LABEL_PATTERN.test(label) ? label : undefined;
}

/** Regional endpoints use the regional token host; custom-subdomain endpoints issue tokens on their own host. */
export function deriveTokenIssuanceUrl(endpoint: AzureEndpoint): string | undefined {
  if (endpoint.kind === "resource") return `${endpoint.origin}${ISSUE_TOKEN_PATH}`;
  const region = regionFromRegionalOrigin(endpoint.origin);
  return region ? `https://${region}.api.cognitive.microsoft.com${ISSUE_TOKEN_PATH}` : undefined;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildProbeSsml(locale: string, voiceId: string, text: string): string {
  return [
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXml(locale)}">`,
    `<voice name="${escapeXml(voiceId)}">${escapeXml(text)}</voice>`,
    "</speak>",
  ].join("");
}

/** Keeps only letters, digits, hyphens, and underscores, so a voice ID cannot escape the output folder. */
export function buildAudioFileName(providerId: VoiceProviderId, voiceId: string): string {
  const stem = voiceId.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  return `${providerId}-${stem || "voice"}.mp3`;
}

export interface AudioProbeReport {
  tool: "ffprobe";
  formatName?: string;
  codecName?: string;
  durationSeconds?: number;
  sampleRateHz?: number;
  channels?: number;
  sizeBytes: number;
}

const FfprobeOutputSchema = z.object({
  format: z.object({ format_name: z.string().optional(), duration: z.string().optional() }).passthrough().optional(),
  streams: z.array(z.object({
    codec_type: z.string().optional(),
    codec_name: z.string().optional(),
    sample_rate: z.string().optional(),
    channels: z.number().optional(),
  }).passthrough()).optional(),
}).passthrough();

export function parseFfprobeReport(json: string, sizeBytes: number): AudioProbeReport {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch {
    throw new LiveCheckError("ffprobe returned an unreadable media report.");
  }
  const parsed = FfprobeOutputSchema.safeParse(parsedJson);
  if (!parsed.success) throw new LiveCheckError("ffprobe returned an unreadable media report.");

  const audio = parsed.data.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(parsed.data.format?.duration);
  const sampleRate = Number(audio?.sample_rate);
  return {
    tool: "ffprobe",
    formatName: parsed.data.format?.format_name,
    codecName: audio?.codec_name,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    sampleRateHz: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : undefined,
    channels: audio?.channels,
    sizeBytes,
  };
}

/** Returns the reasons a file fails verification. An empty list means the file passed. */
export function validateAudioReport(report: AudioProbeReport): string[] {
  const problems: string[] = [];
  if (report.sizeBytes <= 0) problems.push("The audio file is empty.");
  if (!report.formatName?.split(",").includes("mp3")) {
    problems.push(`The container is not MP3 (format: ${(report.formatName ?? "none").slice(0, 40)}).`);
  }
  if (report.codecName !== "mp3") {
    problems.push(`The audio stream is not MP3 (codec: ${(report.codecName ?? "none").slice(0, 40)}).`);
  }
  if (report.durationSeconds === undefined) problems.push("ffprobe reported no positive duration.");
  if (report.sampleRateHz === undefined) problems.push("ffprobe reported no sample rate.");
  return problems;
}

/** Only the stable message is kept. Unknown errors are reduced to their class name, so their text is not printed. */
export function describeFailure(error: unknown): string {
  if (error instanceof VoiceProviderError) return `${error.message} (code: ${error.code})`;
  if (error instanceof LiveCheckError) return error.message;
  if (error instanceof Error) return `Unexpected ${error.name}; details were not printed.`;
  return "Unexpected failure; details were not printed.";
}

export function diagnoseAuth(input: {
  voiceAvailable: boolean;
  adapterPathKey: ProbeOutcome;
  adapterPathBearer: ProbeOutcome;
  alternatePathKey?: ProbeOutcome;
}): string {
  if (!input.voiceAvailable) {
    return "Synthesis probes did not run because the inventory returned no Arabic voice. The voice-list probes show which forms the list endpoint accepted.";
  }
  if (input.adapterPathKey === "accepted") {
    return "Accepted: the adapter's form (Ocp-Apim-Subscription-Key on the adapter's synthesis path) worked. The Authorization: Bearer result is listed for comparison.";
  }
  if (input.adapterPathBearer === "accepted") {
    return "Not accepted: the Ocp-Apim-Subscription-Key form was rejected, but Authorization: Bearer was accepted. The Phase 2 adapter sends only the key header, so it must change before live synthesis can pass. This check did not change it.";
  }
  if (input.alternatePathKey === "accepted") {
    return "Not accepted: the adapter's synthesis path was rejected, but the alternate path /cognitiveservices/v1 accepted the key. The adapter path must change before live synthesis can pass. This check did not change it.";
  }
  return "Not accepted: no synthesis header form or path was accepted. Check the key, the region or endpoint, and the resource state. Status codes are listed above.";
}

// ---------------------------------------------------------------------------
// Side effects: ffprobe, HTTP probes, and the four-step run
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

/** Runs the same bundled ffprobe as render-job.ts, falling back to ffprobe on PATH. */
export async function probeAudioWithFfprobe(filePath: string): Promise<AudioProbeReport> {
  const { size } = await stat(filePath);
  let stdout: string;
  try {
    const result = await execFileAsync(
      getFfprobeExecutable(),
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { encoding: "utf8", timeout: FFPROBE_TIMEOUT_MS, maxBuffer: FFPROBE_MAX_OUTPUT_BYTES },
    );
    stdout = result.stdout;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    throw new LiveCheckError(missing ? "ffprobe is not available on this machine." : "ffprobe could not read the audio file.");
  }
  return parseFfprobeReport(stdout, size);
}

export interface StepRecord {
  step: 1 | 2 | 3 | 4;
  name: "inventory" | "auth-check" | "synthesis" | "verify";
  status: "passed" | "failed" | "skipped";
  detail: string;
}

export interface ProbeRecord {
  check: "token-issuance" | "voices-list" | "synthesis";
  path: string;
  header: ProbeHeader;
  httpStatus?: number;
  outcome: ProbeOutcome;
}

export interface AuthCheckSummary {
  probes: ProbeRecord[];
  /** True only when the adapter's own form (key header on the adapter's synthesis path) was accepted. */
  adapterFormAccepted: boolean;
  diagnosis: string;
}

export interface SynthesisSummary {
  voiceId: string;
  voiceDisplayName?: string;
  locale: string;
  algerianLocale: boolean;
  label: "ALGERIAN (ar-DZ locale tag from inventory)" | "NOT ALGERIAN";
  text: string;
  file: string;
  bytes: number;
  mimeType: "audio/mpeg";
  sha256: string;
}

export interface VerificationSummary extends AudioProbeReport {
  problems: string[];
  valid: boolean;
}

export interface LiveCheckSummary {
  schemaVersion: number;
  generatedAt: string;
  provider: VoiceProviderId;
  endpoint: { kind: "regional" | "custom-subdomain"; region?: string };
  credentialPresence: AzureEnvironmentStatus["presence"];
  status: "passed" | "failed";
  failedStep?: 1 | 2 | 3 | 4;
  failure?: string;
  steps: StepRecord[];
  inventory?: InventorySummary;
  authCheck?: AuthCheckSummary;
  synthesis?: SynthesisSummary;
  verification?: VerificationSummary;
  verdict: {
    pipelinePassed: boolean;
    algerianArabicVoiceReturned: boolean;
    algerianAudioProduced: boolean;
    notVerified: string[];
  };
}

export interface VoiceLiveCheckOptions {
  environment: VoiceProviderEnvironment;
  outputDirectory: string;
  fetcher?: typeof fetch;
  probeAudio?: (filePath: string) => Promise<AudioProbeReport>;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface VoiceLiveCheckResult {
  /** 0 = all four steps passed, 1 = a step failed, 2 = configuration missing or unsupported (no request made). */
  exitCode: 0 | 1 | 2;
  summaryPath?: string;
}

function describeProbe(probe: ProbeRecord): string {
  const status = probe.httpStatus === undefined ? "" : ` (HTTP ${probe.httpStatus})`;
  return `${probe.check} ${probe.path} with ${HEADER_LABELS[probe.header]}: ${probe.outcome}${status}`;
}

async function sendProbe(
  fetcher: typeof fetch,
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  readBody: boolean,
): Promise<{ httpStatus?: number; outcome: ProbeOutcome; body?: string }> {
  try {
    const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(LIVE_CHECK_TIMEOUT_MS) });
    const outcome = classifyHttpStatus(response.status);
    if (!readBody || outcome !== "accepted") {
      await response.body?.cancel().catch(() => undefined);
      return { httpStatus: response.status, outcome };
    }
    return { httpStatus: response.status, outcome, body: await response.text() };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { outcome: timedOut ? "timeout" : "network-error" };
  }
}

interface AuthCheckInput {
  endpoint: AzureEndpoint;
  key: string;
  fetcher: typeof fetch;
  voice?: { voiceId: string; locale: string };
  log: (line: string) => void;
  addSecret: (value: string) => void;
}

/** Tests each documented header form against each endpoint. Records status codes only. */
export async function runAuthCheck(input: AuthCheckInput): Promise<AuthCheckSummary> {
  const routes = getAzureRoutes(input.endpoint.kind);
  const origin = input.endpoint.origin;
  const keyHeaders = { "Ocp-Apim-Subscription-Key": input.key };
  const probes: ProbeRecord[] = [];

  const record = (probe: ProbeRecord): void => {
    probes.push(probe);
    input.log(`  auth probe: ${describeProbe(probe)}`);
  };
  const runProbe = async (
    check: ProbeRecord["check"],
    probePath: string,
    header: ProbeHeader,
    url: string,
    init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  ): Promise<ProbeOutcome> => {
    const result = await sendProbe(input.fetcher, url, init, false);
    record({ check, path: probePath, header, httpStatus: result.httpStatus, outcome: result.outcome });
    return result.outcome;
  };
  const skip = (check: ProbeRecord["check"], probePath: string, header: ProbeHeader): void => {
    record({ check, path: probePath, header, outcome: "not-run" });
  };

  // Token issuance: the key is exchanged for a token that Microsoft says lasts 10 minutes.
  let token: string | undefined;
  const tokenUrl = deriveTokenIssuanceUrl(input.endpoint);
  if (tokenUrl) {
    const result = await sendProbe(input.fetcher, tokenUrl, {
      method: "POST",
      headers: { ...keyHeaders, "Content-type": "application/x-www-form-urlencoded" },
    }, true);
    let outcome = result.outcome;
    if (outcome === "accepted") {
      const candidate = result.body?.trim() ?? "";
      if (TOKEN_PATTERN.test(candidate)) {
        token = candidate;
        input.addSecret(candidate);
      } else {
        outcome = "invalid-token-response";
      }
    }
    record({
      check: "token-issuance",
      path: ISSUE_TOKEN_PATH,
      header: "ocp-apim-subscription-key",
      httpStatus: result.httpStatus,
      outcome,
    });
  } else {
    skip("token-issuance", ISSUE_TOKEN_PATH, "ocp-apim-subscription-key");
  }

  const bearerHeaders = token ? { Authorization: `Bearer ${token}` } : undefined;

  // Voice list, both header forms.
  const voicesUrl = `${origin}${routes.voicesList}`;
  if (bearerHeaders) {
    await runProbe("voices-list", routes.voicesList, "authorization-bearer", voicesUrl, { method: "GET", headers: bearerHeaders });
  } else {
    skip("voices-list", routes.voicesList, "authorization-bearer");
  }
  await runProbe("voices-list", routes.voicesList, "ocp-apim-subscription-key", voicesUrl, { method: "GET", headers: keyHeaders });

  // Synthesis, the surface where the documentation conflicts. Probes use one short phrase.
  let bearerOutcome: ProbeOutcome = "not-run";
  let keyOutcome: ProbeOutcome = "not-run";
  let alternateOutcome: ProbeOutcome | undefined;
  if (input.voice) {
    const body = buildProbeSsml(input.voice.locale, input.voice.voiceId, LIVE_CHECK_PROBE_TEXT);
    const ttsHeaders = {
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": LIVE_CHECK_OUTPUT_FORMAT,
      "User-Agent": LIVE_CHECK_USER_AGENT,
    };
    const primaryUrl = `${origin}${routes.synthesis}`;
    if (bearerHeaders) {
      bearerOutcome = await runProbe("synthesis", routes.synthesis, "authorization-bearer", primaryUrl, {
        method: "POST",
        headers: { ...ttsHeaders, ...bearerHeaders },
        body,
      });
    } else {
      skip("synthesis", routes.synthesis, "authorization-bearer");
    }
    keyOutcome = await runProbe("synthesis", routes.synthesis, "ocp-apim-subscription-key", primaryUrl, {
      method: "POST",
      headers: { ...ttsHeaders, ...keyHeaders },
      body,
    });
    if (routes.alternateSynthesis) {
      alternateOutcome = await runProbe("synthesis", routes.alternateSynthesis, "ocp-apim-subscription-key", `${origin}${routes.alternateSynthesis}`, {
        method: "POST",
        headers: { ...ttsHeaders, ...keyHeaders },
        body,
      });
    }
  } else {
    skip("synthesis", routes.synthesis, "authorization-bearer");
    skip("synthesis", routes.synthesis, "ocp-apim-subscription-key");
    if (routes.alternateSynthesis) skip("synthesis", routes.alternateSynthesis, "ocp-apim-subscription-key");
  }

  return {
    probes,
    adapterFormAccepted: keyOutcome === "accepted",
    diagnosis: diagnoseAuth({
      voiceAvailable: Boolean(input.voice),
      adapterPathKey: keyOutcome,
      adapterPathBearer: bearerOutcome,
      alternatePathKey: alternateOutcome,
    }),
  };
}

/**
 * Removes only this check's own earlier outputs, so an old passing summary cannot be read as the result of a new run.
 * Runs only after the configuration checks pass; a configuration error leaves the folder untouched.
 */
async function removePreviousOutputs(outputDirectory: string): Promise<void> {
  const entries = await readdir(outputDirectory).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((name) => name === SUMMARY_FILE_NAME || name === INVENTORY_FILE_NAME || /^azure-speech-[A-Za-z0-9_-]+\.mp3$/.test(name))
      .map((name) => rm(path.join(outputDirectory, name), { force: true })),
  );
}

function yesNo(value: boolean): string {
  return value ? "present" : "absent";
}

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(LIVE_CHECK_TIMEOUT_MS);
}

function buildInventoryFile(voices: readonly VoiceProfile[], generatedAt: string) {
  return {
    schemaVersion: LIVE_CHECK_SCHEMA_VERSION,
    generatedAt,
    provider: LIVE_CHECK_PROVIDER_ID,
    voiceCount: voices.length,
    voices: voices.map((voice) => ({
      voiceId: voice.voiceId,
      displayName: voice.displayName,
      localeTags: voice.localeTags,
      gender: voice.gender,
    })),
  };
}

/** Runs inventory, auth check, synthesis, and verification. Nothing is logged that could contain a secret. */
export async function runVoiceLiveCheck(options: VoiceLiveCheckOptions): Promise<VoiceLiveCheckResult> {
  const environment = options.environment;
  const fetcher = options.fetcher ?? fetch;
  const probeAudio = options.probeAudio ?? probeAudioWithFfprobe;
  const now = options.now ?? (() => new Date());
  const emit = options.log ?? ((line: string) => console.log(line));
  const secrets: string[] = [environment.AZURE_SPEECH_KEY ?? ""];
  const log = (line: string): void => emit(redactSecrets(line, secrets));
  const outputDirectory = options.outputDirectory;

  const provider = resolveLiveProvider(environment.VOICE_PROVIDER);
  if (!provider.ok) {
    log(`ERROR: ${provider.message} No provider request was made.`);
    return { exitCode: 2 };
  }

  const status = getAzureEnvironmentStatus(environment);
  log(`Provider: ${provider.providerId}. Credential presence (names only): AZURE_SPEECH_KEY ${yesNo(status.presence.AZURE_SPEECH_KEY)}, AZURE_SPEECH_REGION ${yesNo(status.presence.AZURE_SPEECH_REGION)}, AZURE_SPEECH_ENDPOINT ${yesNo(status.presence.AZURE_SPEECH_ENDPOINT)}.`);
  if (status.missing.length > 0) {
    log(`ERROR: Missing required environment variable(s): ${status.missing.join("; ")}. No provider request was made.`);
    return { exitCode: 2 };
  }

  // The adapter's region pattern also accepts a 32-character hex key. A key in the region variable would be
  // sent in a hostname (and to DNS), so refuse before any request. The message never repeats the value.
  const regionValue = environment.AZURE_SPEECH_REGION?.trim() ?? "";
  const keyValue = environment.AZURE_SPEECH_KEY?.trim() ?? "";
  if (regionValue && (regionValue === keyValue || KEY_SHAPED_PATTERN.test(regionValue))) {
    log("ERROR: AZURE_SPEECH_REGION holds a value shaped like a subscription key, not a region name. Put the region (for example eastus) in AZURE_SPEECH_REGION and the key only in AZURE_SPEECH_KEY. No provider request was made.");
    return { exitCode: 2 };
  }

  const adapter = new AzureSpeechAdapter(environment, fetcher);
  const endpoint = getAzureEndpoint(environment);
  if (!adapter.isConfigured() || !endpoint) {
    log("ERROR: AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT has an invalid format. Use a region such as eastus, or an https endpoint on cognitiveservices.azure.com or tts.speech.microsoft.com with no path. No provider request was made.");
    return { exitCode: 2 };
  }

  await mkdir(outputDirectory, { recursive: true });
  await removePreviousOutputs(outputDirectory);

  const generatedAt = now().toISOString();
  const steps: StepRecord[] = [];
  let failure: { step: 1 | 2 | 3 | 4; message: string } | undefined;
  const fail = (step: 1 | 2 | 3 | 4, message: string): void => {
    if (!failure) failure = { step, message };
  };
  let inventory: InventorySummary | undefined;
  let selection: SynthesisSelection<VoiceProfile> | undefined;
  let authCheck: AuthCheckSummary | undefined;
  let synthesis: SynthesisSummary | undefined;
  let verification: VerificationSummary | undefined;
  let audioPath = "";

  // Step 1: inventory. An empty language tag tells the adapter to skip its base-language filter, so the
  // result contains every voice the account can see. Arabic and ar-DZ checks are applied afterwards.
  log("Step 1/4 Inventory: listing every voice through the Phase 2 Azure adapter.");
  try {
    const voices = await adapter.listVoices("", timeoutSignal());
    inventory = summarizeInventory(voices);
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, INVENTORY_FILE_NAME), `${redactSecrets(JSON.stringify(buildInventoryFile(voices, generatedAt), null, 2), secrets)}\n`);
    log(`  Voices returned: ${inventory.voiceCount}. Full list written to ${INVENTORY_FILE_NAME}.`);
    log(`  Arabic locales (ar-*): ${inventory.arabicLocales.length} locale(s), ${inventory.arabicVoiceIds.length} voice(s).`);
    for (const entry of inventory.arabicLocales) {
      log(`    ${entry.locale}: ${entry.voiceCount} voice(s)`);
    }
    log(inventory.algerianLocaleReturned
      ? `  ar-DZ voice returned by the inventory: YES (${inventory.algerianVoices.map((voice) => voice.voiceId).join(", ")}).`
      : "  ar-DZ voice returned by the inventory: NO. Other Arabic locales are NOT Algerian and were not treated as Algerian.");
    selection = selectSynthesisVoice(voices);
    if (!selection) throw new LiveCheckError("No Arabic (ar-*) voice was returned by the inventory.");
    steps.push({ step: 1, name: "inventory", status: "passed", detail: `${inventory.voiceCount} voices; ${inventory.arabicVoiceIds.length} Arabic; ar-DZ ${inventory.algerianLocaleReturned ? "returned" : "not returned"}.` });
  } catch (error) {
    const message = describeFailure(error);
    steps.push({ step: 1, name: "inventory", status: "failed", detail: message });
    fail(1, message);
  }

  // Step 2: auth check. It runs even after a step-1 failure so the header-form evidence is still recorded.
  log("Step 2/4 Auth check: comparing header forms with raw requests. Only status codes are printed.");
  try {
    authCheck = await runAuthCheck({
      endpoint,
      key: keyValue,
      fetcher,
      voice: selection ? { voiceId: selection.voice.voiceId, locale: selection.locale } : undefined,
      log,
      addSecret: (value) => {
        secrets.push(value);
      },
    });
    if (!selection) {
      steps.push({ step: 2, name: "auth-check", status: "skipped", detail: "Synthesis probes need an Arabic voice from step 1." });
    } else if (authCheck.adapterFormAccepted) {
      steps.push({ step: 2, name: "auth-check", status: "passed", detail: authCheck.diagnosis });
    } else {
      steps.push({ step: 2, name: "auth-check", status: "failed", detail: authCheck.diagnosis });
      fail(2, authCheck.diagnosis);
    }
    log(`  ${authCheck.diagnosis}`);
  } catch (error) {
    const message = describeFailure(error);
    steps.push({ step: 2, name: "auth-check", status: "failed", detail: message });
    fail(2, message);
  }

  // Step 3: synthesis. Uses the adapter itself, so it exercises the code path the app uses.
  if (!failure && selection) {
    const label = selection.algerianLocale
      ? "an ar-DZ voice (Algerian locale tag from the inventory)"
      : "a NON-Algerian Arabic voice; no ar-DZ voice was returned";
    log(`Step 3/4 Synthesis: one short Arabic sentence with ${label}.`);
    try {
      const request = VoiceSynthesisRequestSchema.parse({
        projectId: LIVE_CHECK_PROJECT_ID,
        text: LIVE_CHECK_SYNTHESIS_TEXT,
        languageTag: selection.locale,
        provider: LIVE_CHECK_PROVIDER_ID,
        voiceId: selection.voice.voiceId,
        speakingRate: 1,
        outputFormat: "mp3",
      });
      const audio = await adapter.synthesize(request, selection.voice, timeoutSignal());
      const fileName = buildAudioFileName(LIVE_CHECK_PROVIDER_ID, selection.voice.voiceId);
      audioPath = path.join(outputDirectory, fileName);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(audioPath, audio.bytes);
      synthesis = {
        voiceId: selection.voice.voiceId,
        voiceDisplayName: selection.voice.displayName,
        locale: selection.locale,
        algerianLocale: selection.algerianLocale,
        label: selection.algerianLocale ? "ALGERIAN (ar-DZ locale tag from inventory)" : "NOT ALGERIAN",
        text: LIVE_CHECK_SYNTHESIS_TEXT,
        file: fileName,
        bytes: audio.bytes.length,
        mimeType: audio.mimeType,
        sha256: createHash("sha256").update(audio.bytes).digest("hex"),
      };
      log(`  Saved ${fileName} (${audio.bytes.length} bytes). Label: ${synthesis.label}.`);
      steps.push({ step: 3, name: "synthesis", status: "passed", detail: `${synthesis.label}; ${synthesis.bytes} bytes.` });
    } catch (error) {
      const message = describeFailure(error);
      steps.push({ step: 3, name: "synthesis", status: "failed", detail: message });
      fail(3, message);
    }
  } else {
    steps.push({ step: 3, name: "synthesis", status: "skipped", detail: "Not run because an earlier step failed." });
  }

  // Step 4: verification with ffprobe. An empty or non-MP3 file fails here.
  if (!failure && synthesis) {
    log("Step 4/4 Verify: ffprobe checks the saved file.");
    try {
      const report = await probeAudio(audioPath);
      const problems = validateAudioReport(report);
      verification = { ...report, problems, valid: problems.length === 0 };
      if (problems.length > 0) throw new LiveCheckError(`Audio verification failed. ${problems.join(" ")}`);
      log(`  codec=${report.codecName} container=${report.formatName} duration=${report.durationSeconds?.toFixed(3)} s sample_rate=${report.sampleRateHz} Hz channels=${report.channels ?? "unknown"} size=${report.sizeBytes} bytes`);
      steps.push({ step: 4, name: "verify", status: "passed", detail: "ffprobe accepted the file as MP3 with positive duration." });
    } catch (error) {
      const message = describeFailure(error);
      steps.push({ step: 4, name: "verify", status: "failed", detail: message });
      fail(4, message);
    }
  } else {
    steps.push({ step: 4, name: "verify", status: "skipped", detail: "Not run because an earlier step failed." });
  }

  const pipelinePassed = !failure;
  const algerianAudioProduced = pipelinePassed && Boolean(synthesis?.algerianLocale);
  const summary: LiveCheckSummary = {
    schemaVersion: LIVE_CHECK_SCHEMA_VERSION,
    generatedAt,
    provider: LIVE_CHECK_PROVIDER_ID,
    endpoint: endpoint.kind === "resource"
      ? { kind: "custom-subdomain" }
      : { kind: "regional", region: regionFromRegionalOrigin(endpoint.origin) },
    credentialPresence: status.presence,
    status: pipelinePassed ? "passed" : "failed",
    failedStep: failure?.step,
    failure: failure?.message,
    steps,
    inventory,
    authCheck,
    synthesis,
    verification,
    verdict: {
      pipelinePassed,
      algerianArabicVoiceReturned: Boolean(inventory?.algerianLocaleReturned),
      algerianAudioProduced,
      notVerified: [...NOT_VERIFIED_BY_THIS_CHECK],
    },
  };

  const summaryPath = path.join(outputDirectory, SUMMARY_FILE_NAME);
  try {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(summaryPath, `${redactSecrets(JSON.stringify(summary, null, 2), secrets)}\n`);
    log(`Summary written to ${SUMMARY_FILE_NAME}.`);
  } catch {
    log("ERROR: the summary could not be written. The run result below still applies.");
    return { exitCode: 1 };
  }

  if (failure) {
    log(`RESULT: FAILED at step ${failure.step}. ${failure.message}`);
    return { exitCode: 1, summaryPath };
  }
  if (algerianAudioProduced) {
    log("RESULT: PASSED. The inventory returned an ar-DZ voice, and one ar-DZ sample was synthesized and checked by ffprobe. Accent and pronunciation were not judged; listen to the file before relying on it.");
  } else {
    log("RESULT: PIPELINE PASSED, ALGERIAN NOT VERIFIED. The inventory returned no ar-DZ voice. The saved sample uses a NON-Algerian Arabic voice.");
    if (environment.GITHUB_ACTIONS === "true") {
      log("::warning title=Algerian voice not verified::The inventory returned no ar-DZ voice for this account.");
    }
  }
  return { exitCode: 0, summaryPath };
}
