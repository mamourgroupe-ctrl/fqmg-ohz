import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RenderInternals } from "@remotion/renderer";
import { afterEach, describe, expect, it } from "vitest";
import {
  LiveCheckError,
  SUMMARY_FILE_NAME,
  INVENTORY_FILE_NAME,
  buildAudioFileName,
  buildProbeSsml,
  classifyHttpStatus,
  deriveTokenIssuanceUrl,
  describeFailure,
  diagnoseAuth,
  findAlgerianVoices,
  getAzureEnvironmentStatus,
  getAzureRoutes,
  isAlgerianLocale,
  isArabicLocale,
  parseFfprobeReport,
  probeAudioWithFfprobe,
  redactSecrets,
  resolveLiveProvider,
  runVoiceLiveCheck,
  selectSynthesisVoice,
  summarizeArabicLocales,
  summarizeInventory,
  validateAudioReport,
  type AudioProbeReport,
  type InventoryVoice,
} from "../scripts/lib/voice-live-check-core";
import { VoiceProviderError } from "@/voice/providers/provider";
import { getAzureEndpoint } from "@/voice/providers/azure-speech";

// Fake values for tests only. They are not provider credentials and must never appear in output.
const TEST_KEY = "TEST-KEY-not-a-secret-0123456789";
const TEST_TOKEN = "test.token.not-a-secret-value";

function getBundledBinary(type: "ffmpeg" | "ffprobe"): string | undefined {
  try {
    const executable = RenderInternals.getExecutablePath({
      type,
      indent: false,
      logLevel: "error",
      binariesDirectory: null,
    });
    return existsSync(executable) ? executable : undefined;
  } catch {
    return undefined;
  }
}

const bundledFfmpeg = getBundledBinary("ffmpeg");
const bundledFfprobe = getBundledBinary("ffprobe");

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fqmg-voice-live-"));
  cleanupPaths.push(directory);
  return directory;
}

const sampleVoices: InventoryVoice[] = [
  { voiceId: "ar-SA-TestNeural", displayName: "Test SA", localeTags: ["ar-SA"] },
  { voiceId: "ar-EG-TestNeural", displayName: "Test EG", localeTags: ["ar-EG"] },
  { voiceId: "en-US-TestNeural", displayName: "Test EN", localeTags: ["en-US"] },
  { voiceId: "ar-DZ-TestNeural", displayName: "Algerian-named label", localeTags: ["ar-DZ"] },
  { voiceId: "en-US-TestMultilingualNeural", displayName: "Test Multi", localeTags: ["en-US", "ar-DZ"] },
];

// ---------------------------------------------------------------------------
// A. Pure logic. Not provider proof.
// ---------------------------------------------------------------------------

describe("voice live check pure logic (not provider proof)", () => {
  it("defaults to azure and accepts only the Azure selector values", () => {
    expect(resolveLiveProvider(undefined)).toEqual({ ok: true, providerId: "azure-speech" });
    expect(resolveLiveProvider("  ")).toEqual({ ok: true, providerId: "azure-speech" });
    expect(resolveLiveProvider("Azure")).toEqual({ ok: true, providerId: "azure-speech" });
    expect(resolveLiveProvider("azure-speech")).toEqual({ ok: true, providerId: "azure-speech" });
  });

  it("rejects other providers without echoing the value", () => {
    const raw = `openai-${TEST_KEY}`;
    const result = resolveLiveProvider(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain(raw);
      expect(result.message).not.toContain(TEST_KEY);
    }
  });

  it("reports missing Azure variables as names and presence flags only", () => {
    expect(getAzureEnvironmentStatus({})).toEqual({
      presence: { AZURE_SPEECH_KEY: false, AZURE_SPEECH_REGION: false, AZURE_SPEECH_ENDPOINT: false },
      missing: ["AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT"],
    });
    const withKey = getAzureEnvironmentStatus({ AZURE_SPEECH_KEY: TEST_KEY, AZURE_SPEECH_REGION: "eastus" });
    expect(withKey.missing).toEqual([]);
    expect(JSON.stringify(withKey)).not.toContain(TEST_KEY);
    expect(getAzureEnvironmentStatus({ AZURE_SPEECH_KEY: "  ", AZURE_SPEECH_ENDPOINT: "https://x.cognitiveservices.azure.com" }).missing)
      .toEqual(["AZURE_SPEECH_KEY"]);
  });

  it("matches ar-* locales only", () => {
    for (const tag of ["ar-SA", "ar-EG", "ar-DZ", "AR-dz", "ar"]) expect(isArabicLocale(tag)).toBe(true);
    for (const tag of ["en-US", "fr-DZ", "hy-AM", "ary-MA", ""]) expect(isArabicLocale(tag)).toBe(false);
  });

  it("treats only ar-DZ as Algerian, not other Arabic locales or MSA labels", () => {
    expect(isAlgerianLocale("ar-DZ")).toBe(true);
    expect(isAlgerianLocale("ar-dz")).toBe(true);
    for (const tag of ["ar-SA", "ar-EG", "ar-MA", "ar-TN", "ar", "fr-DZ", "en-DZ", "MSA"]) {
      expect(isAlgerianLocale(tag)).toBe(false);
    }
  });

  it("summarizes Arabic locales once per voice and sorts them", () => {
    expect(summarizeArabicLocales(sampleVoices)).toEqual([
      { locale: "ar-DZ", voiceCount: 2 },
      { locale: "ar-EG", voiceCount: 1 },
      { locale: "ar-SA", voiceCount: 1 },
    ]);
  });

  it("finds ar-DZ as a primary or secondary locale and ignores display names", () => {
    expect(findAlgerianVoices(sampleVoices).map((voice) => voice.voiceId)).toEqual([
      "ar-DZ-TestNeural",
      "en-US-TestMultilingualNeural",
    ]);
    const onlyMsa: InventoryVoice[] = [
      { voiceId: "ar-SA-Algerian-Label", displayName: "Algerian", localeTags: ["ar-SA"] },
    ];
    expect(findAlgerianVoices(onlyMsa)).toEqual([]);
  });

  it("reports the inventory state explicitly", () => {
    const withAlgerian = summarizeInventory(sampleVoices);
    expect(withAlgerian.voiceCount).toBe(5);
    expect(withAlgerian.algerianLocaleReturned).toBe(true);
    expect(withAlgerian.arabicVoiceIds).toEqual([
      "ar-DZ-TestNeural",
      "ar-EG-TestNeural",
      "ar-SA-TestNeural",
      "en-US-TestMultilingualNeural",
    ]);
    const withoutAlgerian = summarizeInventory([{ voiceId: "ar-SA-TestNeural", localeTags: ["ar-SA"] }]);
    expect(withoutAlgerian.algerianLocaleReturned).toBe(false);
    expect(withoutAlgerian.algerianVoices).toEqual([]);
  });

  it("prefers a dedicated ar-DZ voice, then a multilingual ar-DZ voice, then any Arabic voice", () => {
    const preferred = selectSynthesisVoice(sampleVoices);
    expect(preferred).toMatchObject({ locale: "ar-DZ", algerianLocale: true });
    expect(preferred?.voice.voiceId).toBe("ar-DZ-TestNeural");

    const multilingualOnly = selectSynthesisVoice([sampleVoices[2], sampleVoices[4]]);
    expect(multilingualOnly).toMatchObject({ locale: "ar-DZ", algerianLocale: true });
    expect(multilingualOnly?.voice.voiceId).toBe("en-US-TestMultilingualNeural");

    const fallback = selectSynthesisVoice([sampleVoices[2], sampleVoices[1], sampleVoices[0]]);
    expect(fallback).toMatchObject({ locale: "ar-EG", algerianLocale: false });
    expect(fallback?.voice.voiceId).toBe("ar-EG-TestNeural");
  });

  it("returns no selection when no Arabic voice exists", () => {
    expect(selectSynthesisVoice([sampleVoices[2]])).toBeUndefined();
    expect(selectSynthesisVoice([])).toBeUndefined();
  });

  it("redacts every occurrence of each secret, longest first, and ignores empty secrets", () => {
    expect(redactSecrets(`a ${TEST_KEY} b ${TEST_KEY}`, [TEST_KEY])).toBe("a [REDACTED] b [REDACTED]");
    expect(redactSecrets("abcdef", ["abc", "abcdef"])).toBe("[REDACTED]");
    expect(redactSecrets("nothing here", [undefined, "", "   "])).toBe("nothing here");
    expect(redactSecrets("x a+b*c? y", ["a+b*c?"])).toBe("x [REDACTED] y");
    // A secret pasted with a trailing newline must still be redacted in its trimmed form.
    expect(redactSecrets(`x ${TEST_KEY} y`, [`${TEST_KEY}\n`])).toBe("x [REDACTED] y");
    const summaryText = JSON.stringify({ failure: `key was ${TEST_KEY}` });
    expect(redactSecrets(summaryText, [TEST_KEY])).not.toContain(TEST_KEY);
  });

  it("classifies HTTP statuses so that only 2xx counts as accepted", () => {
    expect(classifyHttpStatus(200)).toBe("accepted");
    expect(classifyHttpStatus(204)).toBe("accepted");
    expect(classifyHttpStatus(401)).toBe("rejected-authentication");
    expect(classifyHttpStatus(403)).toBe("rejected-authentication");
    expect(classifyHttpStatus(404)).toBe("rejected-request");
    expect(classifyHttpStatus(400)).toBe("rejected-request");
    expect(classifyHttpStatus(429)).toBe("rate-limited");
    expect(classifyHttpStatus(503)).toBe("service-unavailable");
    expect(classifyHttpStatus(302)).toBe("unexpected-status");
  });

  it("derives Azure routes and the token URL for regional and custom-subdomain endpoints", () => {
    const regional = getAzureEndpoint({ AZURE_SPEECH_REGION: "EastUS" });
    expect(regional).toEqual({ origin: "https://eastus.tts.speech.microsoft.com", kind: "regional" });
    expect(getAzureRoutes("regional")).toEqual({
      voicesList: "/cognitiveservices/voices/list",
      synthesis: "/cognitiveservices/v1",
    });
    expect(deriveTokenIssuanceUrl(regional!)).toBe("https://eastus.api.cognitive.microsoft.com/sts/v1.0/issueToken");

    const resource = getAzureEndpoint({ AZURE_SPEECH_ENDPOINT: "https://demo-resource.cognitiveservices.azure.com" });
    expect(resource?.kind).toBe("resource");
    expect(getAzureRoutes("resource")).toEqual({
      voicesList: "/tts/cognitiveservices/voices/list",
      synthesis: "/tts/cognitiveservices/v1",
      alternateSynthesis: "/cognitiveservices/v1",
    });
    expect(deriveTokenIssuanceUrl(resource!)).toBe("https://demo-resource.cognitiveservices.azure.com/sts/v1.0/issueToken");
  });

  it("escapes SSML and keeps audio file names inside the output folder", () => {
    expect(buildProbeSsml("ar-DZ", "ar-DZ-TestNeural", `<b>&"'</b>`)).toContain("&lt;b&gt;&amp;&quot;&apos;&lt;/b&gt;");
    expect(buildAudioFileName("azure-speech", "ar-DZ-AminaNeural")).toBe("azure-speech-ar-DZ-AminaNeural.mp3");
    expect(buildAudioFileName("azure-speech", "../../etc/passwd")).toBe("azure-speech-etc_passwd.mp3");
    expect(buildAudioFileName("azure-speech", "////")).toBe("azure-speech-voice.mp3");
  });

  it("accepts a valid MP3 report and rejects empty, wrong-codec, and undated reports", () => {
    const valid: AudioProbeReport = {
      tool: "ffprobe", formatName: "mp3", codecName: "mp3", durationSeconds: 1.2, sampleRateHz: 24000, channels: 1, sizeBytes: 4096,
    };
    expect(validateAudioReport(valid)).toEqual([]);
    expect(validateAudioReport({ ...valid, sizeBytes: 0 })).toContain("The audio file is empty.");
    expect(validateAudioReport({ ...valid, codecName: "aac", formatName: "mov,mp4,m4a,3gp,3g2,mj2" }).join(" ")).toContain("not MP3");
    expect(validateAudioReport({ ...valid, durationSeconds: undefined })).toContain("ffprobe reported no positive duration.");
    expect(validateAudioReport({ ...valid, sampleRateHz: undefined })).toContain("ffprobe reported no sample rate.");
  });

  it("parses ffprobe JSON and refuses unreadable output", () => {
    const json = JSON.stringify({
      streams: [{ codec_type: "audio", codec_name: "mp3", sample_rate: "24000", channels: 1 }],
      format: { format_name: "mp3", duration: "1.250000" },
    });
    expect(parseFfprobeReport(json, 999)).toEqual({
      tool: "ffprobe", formatName: "mp3", codecName: "mp3", durationSeconds: 1.25, sampleRateHz: 24000, channels: 1, sizeBytes: 999,
    });
    expect(() => parseFfprobeReport("{not json", 1)).toThrow(LiveCheckError);
    const noAudio = parseFfprobeReport(JSON.stringify({ streams: [], format: {} }), 10);
    expect(validateAudioReport(noAudio).join(" ")).toContain("not MP3");
  });

  it("describes failures without printing unknown error messages", () => {
    expect(describeFailure(new VoiceProviderError("azure-speech", "authentication"))).toContain("code: authentication");
    expect(describeFailure(new LiveCheckError("No Arabic voice."))).toBe("No Arabic voice.");
    const unknown = new Error(`leaky ${TEST_KEY}`);
    expect(describeFailure(unknown)).not.toContain(TEST_KEY);
    expect(describeFailure(unknown)).toBe("Unexpected Error; details were not printed.");
  });

  it("explains each header-form outcome, including the adapter's own form", () => {
    expect(diagnoseAuth({ voiceAvailable: true, adapterPathKey: "accepted", adapterPathBearer: "accepted" })).toContain("Accepted");
    expect(diagnoseAuth({ voiceAvailable: true, adapterPathKey: "rejected-authentication", adapterPathBearer: "accepted" }))
      .toContain("Authorization: Bearer was accepted");
    expect(diagnoseAuth({ voiceAvailable: true, adapterPathKey: "rejected-request", adapterPathBearer: "not-run", alternatePathKey: "accepted" }))
      .toContain("/cognitiveservices/v1");
    expect(diagnoseAuth({ voiceAvailable: false, adapterPathKey: "not-run", adapterPathBearer: "not-run" })).toContain("no Arabic voice");
  });
});

// ---------------------------------------------------------------------------
// B. Mocked flow. A fake Azure fetch and a fake probe. Not provider proof.
// ---------------------------------------------------------------------------

const SYNTHETIC_MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(128)]);

const AZURE_VOICE_RECORDS = [
  { ShortName: "ar-DZ-TestNeural", DisplayName: "Test DZ", Locale: "ar-DZ", Gender: "Female" },
  { ShortName: "ar-SA-TestNeural", DisplayName: "Test SA", Locale: "ar-SA", Gender: "Male" },
  { ShortName: "en-US-TestNeural", DisplayName: "Test EN", Locale: "en-US", Gender: "Female" },
];

interface FakeAzureOptions {
  voices?: unknown[];
  voicesKeyAccepted?: boolean;
  ttsKeyAccepted?: boolean;
  ttsBearerAccepted?: boolean;
}

/** MOCK: accepts or rejects requests by header and path. It does not model Azure. */
function createFakeAzure(options: FakeAzureOptions) {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const headers = new Headers(init?.headers);
    const keyHeader = headers.get("Ocp-Apim-Subscription-Key") === TEST_KEY;
    const bearerHeader = headers.get("Authorization") === `Bearer ${TEST_TOKEN}`;
    if (url.pathname.endsWith("/sts/v1.0/issueToken")) {
      return keyHeader
        ? new Response(TEST_TOKEN, { status: 200, headers: { "content-type": "text/plain" } })
        : new Response("", { status: 401 });
    }
    if (url.pathname.endsWith("/voices/list")) {
      const accepted = (keyHeader && (options.voicesKeyAccepted ?? true)) || bearerHeader;
      return accepted ? Response.json(options.voices ?? AZURE_VOICE_RECORDS) : new Response("", { status: 401 });
    }
    if (url.pathname.endsWith("/cognitiveservices/v1")) {
      const accepted = (keyHeader && (options.ttsKeyAccepted ?? true)) || (bearerHeader && (options.ttsBearerAccepted ?? true));
      return accepted
        ? new Response(SYNTHETIC_MP3, { status: 200, headers: { "content-type": "audio/mpeg" } })
        : new Response("", { status: 401 });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetcher, calls };
}

const REGIONAL_ENV = { AZURE_SPEECH_KEY: TEST_KEY, AZURE_SPEECH_REGION: "eastus", VOICE_PROVIDER: "azure" };

/** MOCK probe: reports what a passing MP3 would look like. It does not inspect the file's content. */
const passingProbe = async (filePath: string): Promise<AudioProbeReport> => ({
  tool: "ffprobe",
  formatName: "mp3",
  codecName: "mp3",
  durationSeconds: 1.2,
  sampleRateHz: 24000,
  channels: 1,
  sizeBytes: (await stat(filePath)).size,
});

async function runMockedCheck(options: {
  environment: Record<string, string | undefined>;
  fake: ReturnType<typeof createFakeAzure>;
  probeAudio?: (filePath: string) => Promise<AudioProbeReport>;
}) {
  const outputDirectory = await makeTemporaryDirectory();
  const lines: string[] = [];
  const result = await runVoiceLiveCheck({
    environment: options.environment,
    outputDirectory,
    fetcher: options.fake.fetcher,
    probeAudio: options.probeAudio ?? passingProbe,
    log: (line) => lines.push(line),
    now: () => new Date("2026-10-09T10:00:00.000Z"),
  });
  const summary = result.summaryPath ? JSON.parse(await readFile(result.summaryPath, "utf8")) : undefined;
  return { result, outputDirectory, lines, summary };
}

describe("voice live check mocked flow (MOCK: fake fetch and probe; not provider proof)", () => {
  it("makes no provider request when credentials are missing", async () => {
    const fake = createFakeAzure({});
    const { result, lines, outputDirectory } = await runMockedCheck({ environment: { VOICE_PROVIDER: "azure" }, fake });
    expect(result.exitCode).toBe(2);
    expect(fake.calls).toEqual([]);
    expect(lines.join("\n")).toContain("No provider request was made.");
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  it("makes no provider request for an unsupported provider", async () => {
    const fake = createFakeAzure({});
    const { result, lines } = await runMockedCheck({ environment: { ...REGIONAL_ENV, VOICE_PROVIDER: "elevenlabs" }, fake });
    expect(result.exitCode).toBe(2);
    expect(fake.calls).toEqual([]);
    expect(lines.join("\n")).not.toContain(TEST_KEY);
  });

  it("refuses a key pasted into the region variable before any request, without echoing it", async () => {
    for (const misplaced of [TEST_KEY, "0123456789abcdef0123456789abcdef"]) {
      const fake = createFakeAzure({});
      const { result, lines, outputDirectory } = await runMockedCheck({
        environment: { AZURE_SPEECH_KEY: TEST_KEY, AZURE_SPEECH_REGION: misplaced, VOICE_PROVIDER: "azure" },
        fake,
      });
      expect(result.exitCode).toBe(2);
      expect(fake.calls).toEqual([]);
      expect(lines.join("\n")).toContain("shaped like a subscription key");
      expect(lines.join("\n")).not.toContain(misplaced);
      expect(await readdir(outputDirectory)).toEqual([]);
    }
  });

  it("passes the pipeline with an ar-DZ voice, lists every voice, and keeps the key out of all outputs", async () => {
    const fake = createFakeAzure({});
    const { result, lines, outputDirectory, summary } = await runMockedCheck({ environment: REGIONAL_ENV, fake });

    expect(result.exitCode).toBe(0);
    expect(summary).toMatchObject({
      status: "passed",
      endpoint: { kind: "regional", region: "eastus" },
      verdict: { pipelinePassed: true, algerianArabicVoiceReturned: true, algerianAudioProduced: true },
      synthesis: { voiceId: "ar-DZ-TestNeural", locale: "ar-DZ", algerianLocale: true, label: "ALGERIAN (ar-DZ locale tag from inventory)" },
      verification: { valid: true, codecName: "mp3", sampleRateHz: 24000 },
    });
    expect(summary.inventory.voiceCount).toBe(AZURE_VOICE_RECORDS.length);

    const inventory = JSON.parse(await readFile(path.join(outputDirectory, INVENTORY_FILE_NAME), "utf8"));
    expect(inventory.voices.map((voice: { voiceId: string }) => voice.voiceId)).toEqual([
      "ar-DZ-TestNeural",
      "ar-SA-TestNeural",
      "en-US-TestNeural",
    ]);

    expect(lines.join("\n")).toContain("ar-DZ voice returned by the inventory: YES");
    expect(lines.join("\n")).toContain("RESULT: PASSED");
    const files = await readdir(outputDirectory);
    expect(files).toEqual(expect.arrayContaining([SUMMARY_FILE_NAME, INVENTORY_FILE_NAME, "azure-speech-ar-DZ-TestNeural.mp3"]));
    for (const name of files) {
      const content = await readFile(path.join(outputDirectory, name));
      expect(content.includes(TEST_KEY)).toBe(false);
      expect(content.includes(TEST_TOKEN)).toBe(false);
    }
    expect(lines.join("\n").includes(TEST_KEY)).toBe(false);
    expect(lines.join("\n").includes(TEST_TOKEN)).toBe(false);
    expect(fake.calls.some((call) => call.endsWith("/sts/v1.0/issueToken"))).toBe(true);
  });

  it("labels a non-Algerian fallback clearly and reports ar-DZ as not returned", async () => {
    const fake = createFakeAzure({ voices: AZURE_VOICE_RECORDS.slice(1) });
    const { result, lines, summary } = await runMockedCheck({ environment: REGIONAL_ENV, fake });

    expect(result.exitCode).toBe(0);
    expect(summary.verdict).toMatchObject({ pipelinePassed: true, algerianArabicVoiceReturned: false, algerianAudioProduced: false });
    expect(summary.synthesis).toMatchObject({ voiceId: "ar-SA-TestNeural", locale: "ar-SA", algerianLocale: false, label: "NOT ALGERIAN" });
    const output = lines.join("\n");
    expect(output).toContain("ar-DZ voice returned by the inventory: NO");
    expect(output).toContain("RESULT: PIPELINE PASSED, ALGERIAN NOT VERIFIED");
  });

  it("stops at step 2 when the adapter's key form fails on synthesis but Bearer works, and says so", async () => {
    const fake = createFakeAzure({ ttsKeyAccepted: false, ttsBearerAccepted: true });
    const { result, lines, summary } = await runMockedCheck({ environment: REGIONAL_ENV, fake });

    expect(result.exitCode).toBe(1);
    expect(summary).toMatchObject({ status: "failed", failedStep: 2 });
    expect(summary.authCheck.adapterFormAccepted).toBe(false);
    expect(summary.authCheck.probes).toEqual(expect.arrayContaining([
      expect.objectContaining({ check: "synthesis", header: "authorization-bearer", outcome: "accepted", httpStatus: 200 }),
      expect.objectContaining({ check: "synthesis", header: "ocp-apim-subscription-key", outcome: "rejected-authentication", httpStatus: 401 }),
    ]));
    expect(lines.join("\n")).toContain("Authorization: Bearer was accepted");
    expect(lines.join("\n")).toContain("RESULT: FAILED at step 2");
    expect(fake.calls.some((call) => call.includes("/cognitiveservices/v1"))).toBe(true);
    expect(lines.join("\n").includes(TEST_KEY)).toBe(false);
  });

  it("fails at step 1 when the inventory returns no Arabic voice, without attempting synthesis", async () => {
    const fake = createFakeAzure({ voices: [AZURE_VOICE_RECORDS[2]] });
    const { result, summary, lines } = await runMockedCheck({ environment: REGIONAL_ENV, fake });

    expect(result.exitCode).toBe(1);
    expect(summary).toMatchObject({ status: "failed", failedStep: 1 });
    expect(summary.steps.map((step: { status: string }) => step.status)).toEqual(["failed", "skipped", "skipped", "skipped"]);
    expect(fake.calls.some((call) => call.includes("/cognitiveservices/v1"))).toBe(false);
    expect(lines.join("\n")).toContain("No Arabic (ar-*) voice was returned");
  });

  it("replaces a stale passing summary and stale audio from an earlier run", async () => {
    const fake = createFakeAzure({ voices: [AZURE_VOICE_RECORDS[2]] });
    const outputDirectory = await makeTemporaryDirectory();
    await writeFile(path.join(outputDirectory, SUMMARY_FILE_NAME), JSON.stringify({ status: "passed" }));
    await writeFile(path.join(outputDirectory, "azure-speech-old-Voice.mp3"), SYNTHETIC_MP3);
    const result = await runVoiceLiveCheck({
      environment: REGIONAL_ENV,
      outputDirectory,
      fetcher: fake.fetcher,
      probeAudio: passingProbe,
      log: () => undefined,
      now: () => new Date("2026-10-09T10:00:00.000Z"),
    });

    expect(result.exitCode).toBe(1);
    const summary = JSON.parse(await readFile(path.join(outputDirectory, SUMMARY_FILE_NAME), "utf8"));
    expect(summary).toMatchObject({ status: "failed", failedStep: 1 });
    expect(existsSync(path.join(outputDirectory, "azure-speech-old-Voice.mp3"))).toBe(false);
  });

  it("fails at step 4 when ffprobe reports a non-MP3 file, and keeps the file for diagnosis", async () => {
    const fake = createFakeAzure({});
    const badProbe = async (filePath: string): Promise<AudioProbeReport> => ({
      ...(await passingProbe(filePath)),
      codecName: "aac",
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
    });
    const { result, summary, outputDirectory } = await runMockedCheck({ environment: REGIONAL_ENV, fake, probeAudio: badProbe });

    expect(result.exitCode).toBe(1);
    expect(summary).toMatchObject({ status: "failed", failedStep: 4, verification: { valid: false } });
    expect(existsSync(path.join(outputDirectory, "azure-speech-ar-DZ-TestNeural.mp3"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C. Real local ffprobe on a real MP3 made with the bundled encoder. Tool test. Not provider proof.
// ---------------------------------------------------------------------------

describe("real local ffprobe on a locally encoded MP3 (tool test; not provider proof)", () => {
  it.skipIf(!bundledFfmpeg || !bundledFfprobe)("accepts a real MP3 and rejects empty and garbage files", async () => {
    const directory = await makeTemporaryDirectory();
    const mp3Path = path.join(directory, "sample.mp3");
    execFileSync(bundledFfmpeg!, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-ar", "24000", "-ac", "1",
      "-c:a", "libmp3lame", "-b:a", "128k",
      "-y", mp3Path,
    ], { timeout: 30_000 });

    const report = await probeAudioWithFfprobe(mp3Path);
    expect(report).toMatchObject({ codecName: "mp3", sampleRateHz: 24000, channels: 1 });
    expect(report.durationSeconds).toBeGreaterThan(0.5);
    expect(validateAudioReport(report)).toEqual([]);

    const emptyPath = path.join(directory, "empty.mp3");
    await writeFile(emptyPath, Buffer.alloc(0));
    await expect(probeAudioWithFfprobe(emptyPath)).rejects.toThrow("ffprobe could not read the audio file.");

    const garbagePath = path.join(directory, "garbage.mp3");
    await writeFile(garbagePath, "not audio");
    await expect(probeAudioWithFfprobe(garbagePath)).rejects.toThrow(LiveCheckError);
    expect((await stat(mp3Path)).size).toBeGreaterThan(100);
  });
});
