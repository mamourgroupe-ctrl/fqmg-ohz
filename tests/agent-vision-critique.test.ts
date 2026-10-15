import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildVisionPayload,
  critiqueFrames,
  estimateVisionCritiqueCost,
  extractJsonObject,
  getVisionRubric,
  parseVisionCritique,
  VisionCritiqueError,
  type CritiqueFrame,
  type VisionProvider,
  type VisionProviderRequest,
} from "@/agent/vision-critique";
import { createDisabledVisionProvider, createOpenAiCompatibleVisionProvider } from "@/agent/vision-providers";
import { inspectImage, detectImageMimeType, SUPPORTED_IMAGE_MIME_TYPES } from "@/agent/image-inspection";
import { EMPTY_PRICE_BOOK, type PriceBook } from "@/agent/pricing";

const syntheticPngFrame = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAIAAACwpMoFAAAAQElEQVR4nO3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8GOpGgABimw4TgAAAABJRU5ErkJggg==",
  "base64",
);

function frame(index = 0): CritiqueFrame {
  return {
    index,
    bytes: syntheticPngFrame,
    width: 160,
    height: 90,
    timestampSeconds: index * 0.5,
    sha256: String(index).repeat(64).slice(0, 64),
  };
}

function approvingJson(): string {
  return JSON.stringify({
    verdict: "approve",
    score: 8.5,
    issues: [],
    summary: "Frames are legible and the composition resolves cleanly.",
  });
}

function revisingJson(): string {
  return JSON.stringify({
    verdict: "revise",
    score: 4,
    issues: [
      {
        code: "typography-contrast",
        severity: "critical",
        frameIndex: 0,
        message: "The headline disappears against the mid-tone background.",
      },
    ],
    summary: "Contrast failure in the opening frame.",
  });
}

function stubProvider(
  responder: (request: VisionProviderRequest) => Promise<unknown> | unknown,
  overrides: Partial<VisionProvider> = {},
): VisionProvider & { calls: VisionProviderRequest[] } {
  const calls: VisionProviderRequest[] = [];
  return {
    id: "stub-vision",
    modelId: "stub-model",
    isConfigured: true,
    calls,
    async critique(request: VisionProviderRequest) {
      calls.push(request);
      return responder(request);
    },
    ...overrides,
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("Network access is not allowed in unit tests.");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("image inspection", () => {
  it("accepts only the documented MIME types", () => {
    expect(SUPPORTED_IMAGE_MIME_TYPES).toEqual(["image/jpeg", "image/png"]);
    expect(detectImageMimeType(syntheticPngFrame)).toBe("image/png");
    expect(detectImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe("image/jpeg");
    expect(detectImageMimeType(Buffer.from("GIF89a", "ascii"))).toBeUndefined();
    expect(detectImageMimeType(Buffer.alloc(0))).toBeUndefined();
  });

  it("reads PNG and JPEG dimensions and rejects broken or oversized images", () => {
    const png = inspectImage(syntheticPngFrame);
    expect(png).toMatchObject({ mimeType: "image/png", width: 160, height: 90 });

    // Minimal JPEG header: SOI, SOF0 with 100x200, EOI.
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0x03, 0x01, 0x11, 0x00,
      0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
    ]);
    expect(inspectImage(jpeg)).toMatchObject({ mimeType: "image/jpeg", width: 200, height: 100 });

    expect(() => inspectImage(Buffer.alloc(0))).toThrowError(/empty/i);
    expect(() => inspectImage(Buffer.from("not an image"))).toThrowError(/image\/jpeg or image\/png/);
    expect(() =>
      inspectImage(syntheticPngFrame, { maxBytes: 100, maxWidth: 512, maxHeight: 512, minWidth: 8, maxImages: 1 }),
    ).toThrowError(/byte limit/i);
    expect(() =>
      inspectImage(syntheticPngFrame, { maxBytes: 10_000, maxWidth: 512, maxHeight: 512, minWidth: 400, maxImages: 1 }),
    ).toThrowError(/at least 400px/);
    expect(() =>
      inspectImage(syntheticPngFrame, { maxBytes: 10_000, maxWidth: 100, maxHeight: 512, minWidth: 8, maxImages: 1 }),
    ).toThrowError(/must not exceed/);

    const truncated = Buffer.from(syntheticPngFrame.subarray(0, 16));
    expect(() => inspectImage(truncated)).toThrow();
  });
});

describe("vision payload construction", () => {
  it("encodes frames as data URLs and enforces count, byte, and dimension limits", () => {
    const payload = buildVisionPayload([frame(0), frame(1)]);
    expect(payload.frames).toHaveLength(2);
    expect(payload.frames[0].dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(payload.payloadBytes).toBeGreaterThan(0);

    expect(() => buildVisionPayload([])).toThrowError(VisionCritiqueError);
    expect(() => buildVisionPayload(Array.from({ length: 7 }, (_, index) => frame(index)))).toThrowError(
      /at most 6 frames/,
    );
    expect(() =>
      buildVisionPayload([frame(0)], {
        maxBytes: 100,
        maxWidth: 512,
        maxHeight: 512,
        minWidth: 8,
        maxImages: 6,
        maxPayloadBytes: 6 * 1024 * 1024,
      }),
    ).toThrowError(/byte limit/);
    expect(() =>
      buildVisionPayload([frame(0)], {
        maxBytes: 10_000,
        maxWidth: 64,
        maxHeight: 64,
        minWidth: 8,
        maxImages: 6,
        maxPayloadBytes: 6 * 1024 * 1024,
      }),
    ).toThrowError(/must not exceed/);
  });
});

describe("critique parsing", () => {
  it("accepts a plain JSON object, a fenced object, and an object embedded in prose", () => {
    expect(parseVisionCritique(approvingJson())).toMatchObject({ verdict: "approve", score: 8.5 });
    expect(parseVisionCritique(`\`\`\`json\n${approvingJson()}\n\`\`\``)).toMatchObject({ verdict: "approve" });
    expect(parseVisionCritique(`Here is my review:\n${approvingJson()}\nThanks.`)).toMatchObject({
      verdict: "approve",
    });
    expect(parseVisionCritique(JSON.parse(approvingJson()) as unknown)).toMatchObject({ verdict: "approve" });
    expect(extractJsonObject("no json here")).toBeUndefined();
  });

  const malformed: Array<[string, string]> = [
    ["non-JSON text", "The render looks mostly fine to me."],
    ["missing verdict", JSON.stringify({ score: 8, issues: [], summary: "fine" })],
    ["unknown rule code", JSON.stringify({
      verdict: "revise",
      score: 3,
      issues: [{ code: "made-up-rule", severity: "major", message: "Something looks off here." }],
      summary: "Unknown rule reference.",
    })],
    ["incomplete issue", JSON.stringify({
      verdict: "revise",
      score: 3,
      issues: [{ code: "layout-safe-area", severity: "major" }],
      summary: "Missing message.",
    })],
    ["revise without issues", JSON.stringify({ verdict: "revise", score: 2, issues: [], summary: "Not good." })],
    ["approve with a critical issue", JSON.stringify({
      verdict: "approve",
      score: 9,
      issues: [{ code: "content-no-placeholders", severity: "critical", message: "Placeholder text is visible." }],
      summary: "Contradictory verdict.",
    })],
    ["approve with a low score", JSON.stringify({ verdict: "approve", score: 4, issues: [], summary: "Fine." })],
    ["out-of-range score", JSON.stringify({ verdict: "revise", score: 42, issues: [], summary: "Fine." })],
  ];

  it.each(malformed)("rejects malformed output: %s", (_label, raw) => {
    expect(() => parseVisionCritique(raw)).toThrowError(VisionCritiqueError);
    try {
      parseVisionCritique(raw);
    } catch (error) {
      expect((error as VisionCritiqueError).code).toBe("invalid-response");
    }
  });
});

describe("critiqueFrames", () => {
  it("never calls the network and passes the token budget to the provider", async () => {
    const provider = stubProvider(() => approvingJson());
    const outcome = await critiqueFrames({
      frames: [frame(0), frame(1)],
      provider,
      maxOutputTokens: 512,
      timeoutMs: 5_000,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].maxOutputTokens).toBe(512);
    expect(provider.calls[0].frames).toHaveLength(2);
    expect(provider.calls[0].rubric.length).toBeGreaterThan(5);
    expect(outcome).toMatchObject({
      providerId: "stub-vision",
      modelId: "stub-model",
      frameCount: 2,
    });
    expect(outcome.frameHashes).toEqual([frame(0).sha256, frame(1).sha256]);
    expect(outcome.critique.verdict).toBe("approve");
    expect(getVisionRubric().length).toBeGreaterThan(0);
  });

  it("refuses to call an unconfigured provider", async () => {
    const provider = createDisabledVisionProvider("unconfigured");
    await expect(
      critiqueFrames({ frames: [frame()], provider, maxOutputTokens: 256, timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: "provider-unconfigured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("turns a provider failure into a redacted, safe error", async () => {
    process.env.AGENT_TEST_SECRET = "super-secret-value-1234567890";
    const provider = stubProvider(() => {
      throw new Error(
        "Request failed with Authorization: Bearer super-secret-value-1234567890 and api_key=super-secret-value-1234567890",
      );
    });

    try {
      await critiqueFrames({ frames: [frame()], provider, maxOutputTokens: 256, timeoutMs: 1_000 });
      throw new Error("expected critiqueFrames to reject");
    } catch (error) {
      const critiqueError = error as VisionCritiqueError;
      expect(critiqueError.code).toBe("provider-failed");
      const haystack = `${critiqueError.message} ${critiqueError.detail ?? ""}`;
      expect(haystack).not.toContain("super-secret-value-1234567890");
      expect(haystack).toContain("[REDACTED]");
    } finally {
      delete process.env.AGENT_TEST_SECRET;
    }
  });

  it("reports a timeout instead of waiting forever", async () => {
    const provider = stubProvider(() => new Promise<never>(() => undefined));
    await expect(
      critiqueFrames({ frames: [frame()], provider, maxOutputTokens: 256, timeoutMs: 25 }),
    ).rejects.toMatchObject({ code: "provider-timeout" });
  });

  it("honours cancellation before and during the provider call", async () => {
    const beforeAbort = new AbortController();
    beforeAbort.abort(new Error("cancelled"));
    await expect(
      critiqueFrames({
        frames: [frame()],
        provider: stubProvider(() => approvingJson()),
        maxOutputTokens: 256,
        timeoutMs: 1_000,
        signal: beforeAbort.signal,
      }),
    ).rejects.toMatchObject({ code: "provider-cancelled" });

    const during = new AbortController();
    const provider: VisionProvider = {
      id: "hanging",
      modelId: "hanging",
      isConfigured: true,
      async critique(request: VisionProviderRequest) {
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    const pending = critiqueFrames({
      frames: [frame()],
      provider,
      maxOutputTokens: 256,
      timeoutMs: 5_000,
      signal: during.signal,
    });
    during.abort(new Error("cancelled by caller"));
    await expect(pending).rejects.toMatchObject({ code: "provider-cancelled" });
  });

  it("rejects a malformed provider response before it can drive a repair", async () => {
    const provider = stubProvider(() => "The frames look acceptable but I cannot score them.");
    await expect(
      critiqueFrames({ frames: [frame()], provider, maxOutputTokens: 256, timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("estimates an upper-bound cost only when a verified price exists", () => {
    const framesForCost = [{ width: 512, height: 512 }];
    expect(
      estimateVisionCritiqueCost({
        priceBook: EMPTY_PRICE_BOOK,
        providerId: "stub-vision",
        modelId: "stub-model",
        frames: framesForCost,
        maxOutputTokens: 600,
      }),
    ).toBeUndefined();

    const priceBook: PriceBook = {
      entries: [
        {
          providerId: "stub-vision",
          modelId: "stub-model",
          unit: "per-million-tokens",
          inputUsdPerMillionTokens: 0.1,
          outputUsdPerMillionTokens: 0.4,
          sourceUrl: "https://example.invalid/pricing",
          verifiedOn: "2026-10-15",
        },
      ],
    };
    const estimate = estimateVisionCritiqueCost({
      priceBook,
      providerId: "stub-vision",
      modelId: "stub-model",
      frames: framesForCost,
      maxOutputTokens: 600,
    });
    expect(estimate?.usd).toBeGreaterThan(0);
    expect(estimate?.basis).toContain("example.invalid");
  });

  it("returns a revise verdict that still satisfies the contract", async () => {
    const provider = stubProvider(() => revisingJson());
    const outcome = await critiqueFrames({
      frames: [frame()],
      provider,
      maxOutputTokens: 400,
      timeoutMs: 1_000,
    });
    expect(outcome.critique.verdict).toBe("revise");
    expect(outcome.critique.issues[0].code).toBe("typography-contrast");
  });
});

describe("openai-compatible vision adapter", () => {
  it("refuses to exist without explicit confirmation that the model accepts images", () => {
    expect(() =>
      createOpenAiCompatibleVisionProvider({
        id: "openai-compatible",
        modelId: "vision-model",
        apiKey: "test-key",
        baseUrl: "https://example.invalid/v1",
        imageSupportVerifiedByOperator: false,
      }),
    ).toThrowError(/documentation/i);
  });

  it("sends data URLs and the output-token budget with an injected fetcher only", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: approvingJson() } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = createOpenAiCompatibleVisionProvider({
      id: "openai-compatible",
      modelId: "vision-model",
      apiKey: "test-key",
      baseUrl: "https://example.invalid/v1/",
      fetcher: fetcher as unknown as typeof fetch,
      imageSupportVerifiedByOperator: true,
      requestJsonResponseFormat: true,
    });

    expect(provider.isConfigured).toBe(true);
    const raw = await provider.critique({
      frames: buildVisionPayload([frame()]).frames,
      rubric: ["rule"],
      prompt: "review this",
      maxOutputTokens: 321,
      signal: new AbortController().signal,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.invalid/v1/chat/completions");
    const body = JSON.parse(String(init.body)) as {
      max_tokens: number;
      response_format: { type: string };
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.max_tokens).toBe(321);
    expect(body.response_format).toEqual({ type: "json_object" });
    const userContent = body.messages[1].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(userContent.filter((part) => part.type === "image_url")).toHaveLength(1);
    expect(userContent[0].type).toBe("text");
    expect(parseVisionCritique(raw)).toMatchObject({ verdict: "approve" });
  });

  it("fails closed on HTTP errors and unusable responses", async () => {
    const failing = createOpenAiCompatibleVisionProvider({
      id: "openai-compatible",
      modelId: "vision-model",
      apiKey: "test-key",
      baseUrl: "https://example.invalid/v1",
      fetcher: (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch,
      imageSupportVerifiedByOperator: true,
    });
    await expect(
      failing.critique({
        frames: buildVisionPayload([frame()]).frames,
        rubric: [],
        prompt: "x",
        maxOutputTokens: 10,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrowError(/HTTP 502/);

    const empty = createOpenAiCompatibleVisionProvider({
      id: "openai-compatible",
      modelId: "vision-model",
      apiKey: "test-key",
      baseUrl: "https://example.invalid/v1",
      fetcher: (async () =>
        new Response(JSON.stringify({ choices: [] }), { status: 200 })) as unknown as typeof fetch,
      imageSupportVerifiedByOperator: true,
    });
    await expect(
      empty.critique({
        frames: buildVisionPayload([frame()]).frames,
        rubric: [],
        prompt: "x",
        maxOutputTokens: 10,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrowError(/no assistant message content/);

    const noKey = createOpenAiCompatibleVisionProvider({
      id: "openai-compatible",
      modelId: "vision-model",
      apiKey: undefined,
      baseUrl: "https://example.invalid/v1",
      imageSupportVerifiedByOperator: true,
    });
    expect(noKey.isConfigured).toBe(false);
  });
});
