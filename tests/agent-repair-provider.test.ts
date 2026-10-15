import { beforeEach, describe, expect, it, vi } from "vitest";
import previewSpecification from "../templates/phase-one-preview.json";
import {
  createDisabledMotionRepairProvider,
  createGenerateObjectRepairProvider,
  MotionRepairError,
  validateRepairCandidate,
} from "@/agent/repair-provider";
import { MotionSpecificationSchema, type MotionSpecification } from "@/motion/schemas/motion-specification";

function createSpecification(): MotionSpecification {
  return MotionSpecificationSchema.parse(structuredClone(previewSpecification)) as MotionSpecification;
}

function withImageAsset(specification: MotionSpecification, source: string): MotionSpecification {
  specification.assets.push({
    id: "brand-logo",
    name: "Brand logo",
    kind: "image",
    source,
    licenseStatus: "licensed",
  });
  return specification;
}

function requestFor(specification: MotionSpecification) {
  return {
    specification,
    issues: [
      {
        code: "layout-safe-area",
        severity: "major" as const,
        message: "The headline layer extends past the safe area.",
        sceneId: specification.scenes[0].id,
      },
    ],
    rubric: ["layout-safe-area: keep content inside the safe area"],
    maxOutputTokens: 4_000,
    signal: new AbortController().signal,
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("Network access is not allowed in unit tests.");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

describe("repair candidate validation", () => {
  it("accepts a valid candidate in both accepted shapes", () => {
    const specification = createSpecification();
    const repaired = createSpecification();
    repaired.scenes[0].title = "Repaired title";

    expect(validateRepairCandidate(specification, repaired).scenes[0].title).toBe("Repaired title");
    expect(
      validateRepairCandidate(specification, { specification: repaired }).scenes[0].title,
    ).toBe("Repaired title");
    expect(validateRepairCandidate(specification, specification)).toEqual(specification);
  });

  it("refuses a candidate that does not satisfy the motion specification schema", () => {
    const specification = createSpecification();
    expect(() => validateRepairCandidate(specification, { not: "a specification" })).toThrowError(
      MotionRepairError,
    );
    try {
      validateRepairCandidate(specification, { not: "a specification" });
    } catch (error) {
      expect((error as MotionRepairError).code).toBe("invalid-candidate");
    }

    const missingScenes = structuredClone(specification) as unknown as Record<string, unknown>;
    delete missingScenes.scenes;
    expect(() => validateRepairCandidate(specification, missingScenes)).toThrowError(MotionRepairError);
  });

  it.each([
    [
      "project identity",
      (candidate: MotionSpecification) => {
        candidate.project.id = "someone-elses-project";
      },
    ],
    [
      "composition size",
      (candidate: MotionSpecification) => {
        // Still a valid 9:16 preset, so only the integrity check can refuse it.
        candidate.composition.width = 810;
        candidate.composition.height = 1440;
      },
    ],
    [
      "frame rate",
      (candidate: MotionSpecification) => {
        candidate.composition.fps = 60;
      },
    ],
    [
      "duration",
      (candidate: MotionSpecification) => {
        candidate.composition.durationInFrames = 900;
      },
    ],
    [
      "scene count",
      (candidate: MotionSpecification) => {
        candidate.scenes.pop();
      },
    ],
    [
      "scene identity",
      (candidate: MotionSpecification) => {
        candidate.scenes[0].id = "renamed-scene";
      },
    ],
    [
      "new assets",
      (candidate: MotionSpecification) => {
        candidate.assets.push({
          id: "injected-asset",
          name: "Injected",
          kind: "image",
          source: "https://attacker.invalid/tracker.png",
          licenseStatus: "user-provided",
        });
      },
    ],
    [
      "repointed asset sources",
      (candidate: MotionSpecification) => {
        candidate.assets[0].source = "https://attacker.invalid/tracker.png";
      },
    ],
  ])("refuses a repair that changes the %s", (_label, mutate) => {
    // Only the repointed-source case needs a pre-existing asset to repoint.
    const specification =
      _label === "repointed asset sources"
        ? withImageAsset(createSpecification(), "/assets/brand-logo.png")
        : createSpecification();
    const candidate = structuredClone(specification);
    mutate(candidate);

    try {
      validateRepairCandidate(specification, candidate);
      throw new Error("expected the candidate to be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(MotionRepairError);
      // A canvas that is not one of the supported presets is already refused by the existing
      // specification schema; every other change is refused by the integrity check below.
      const expectedCodes =
        _label === "composition size" ? ["invalid-candidate"] : ["integrity-violation"];
      expect(expectedCodes).toContain((error as MotionRepairError).code);
    }
  });

  it("refuses executable and data-URL asset sources through the existing specification schema", () => {
    const specification = withImageAsset(createSpecification(), "/assets/brand-logo.png");

    for (const source of ["javascript:alert(1)", "data:image/png;base64,AAAA", "file:///etc/passwd"]) {
      const candidate = structuredClone(specification);
      candidate.assets[0].source = source;
      try {
        validateRepairCandidate(specification, candidate);
        throw new Error(`expected "${source}" to be refused`);
      } catch (error) {
        expect(error).toBeInstanceOf(MotionRepairError);
        expect((error as MotionRepairError).code).toBe("invalid-candidate");
      }
    }
  });
});

describe("AI repair provider", () => {
  it("fails closed when the provider is disabled", async () => {
    const provider = createDisabledMotionRepairProvider("gpt-test");
    expect(provider.isConfigured).toBe(false);
    await expect(provider.propose(requestFor(createSpecification()))).rejects.toMatchObject({
      code: "provider-unconfigured",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the rubric and issues with an explicit output-token budget, and never fetches", async () => {
    const specification = createSpecification();
    const generate = vi.fn(async (_input: unknown) => ({ object: { specification } }));
    const provider = createGenerateObjectRepairProvider({
      id: "model-router:openai",
      modelId: "gpt-test",
      model: {} as never,
      generate: generate as never,
    });

    expect(provider.isConfigured).toBe(true);
    const result = await provider.propose(requestFor(specification));

    expect(result).toEqual({ specification });
    expect(fetchSpy).not.toHaveBeenCalled();
    const call = generate.mock.calls[0][0] as unknown as {
      maxOutputTokens: number;
      prompt: string;
      schema: unknown;
      abortSignal: AbortSignal;
    };
    expect(call.maxOutputTokens).toBe(4_000);
    expect(call.prompt).toContain("layout-safe-area");
    expect(call.prompt).toContain("The headline layer extends past the safe area.");
    expect(call.prompt).toContain("Motion rules:");
    expect(call.prompt).toContain("Do not change project.id");
    expect(call.schema).toBeDefined();
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("reports a redacted provider failure and a cancellation", async () => {
    process.env.AGENT_REPAIR_TEST_SECRET = "repair-secret-value-abcdef123456";
    const specification = createSpecification();

    const failing = createGenerateObjectRepairProvider({
      id: "model-router:openai",
      modelId: "gpt-test",
      model: {} as never,
      generate: (async () => {
        throw new Error(
          "Provider responded 401 with api_key=repair-secret-value-abcdef123456 and path /home/user/fqmg-ohz/src/agent/repair-provider.ts",
        );
      }) as never,
    });

    try {
      await failing.propose(requestFor(specification));
      throw new Error("expected the repair provider to fail");
    } catch (error) {
      const repairError = error as MotionRepairError;
      expect(repairError.code).toBe("provider-failed");
      const haystack = `${repairError.message} ${repairError.detail ?? ""}`;
      expect(haystack).not.toContain("repair-secret-value-abcdef123456");
      expect(haystack).not.toContain("/home/user/fqmg-ohz/src/agent/repair-provider.ts");
    } finally {
      delete process.env.AGENT_REPAIR_TEST_SECRET;
    }

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const cancelled = createGenerateObjectRepairProvider({
      id: "model-router:openai",
      modelId: "gpt-test",
      model: {} as never,
      generate: (async () => {
        throw new Error("aborted");
      }) as never,
    });

    await expect(
      cancelled.propose({ ...requestFor(specification), signal: controller.signal }),
    ).rejects.toMatchObject({ code: "provider-cancelled" });
  });

  it("returns the untrusted object unchanged so validation stays the caller's job", async () => {
    const generate = vi.fn(async (_input: unknown) => ({ object: { specification: { nonsense: true } } }));
    const provider = createGenerateObjectRepairProvider({
      id: "model-router:openai",
      modelId: "gpt-test",
      model: {} as never,
      generate: generate as never,
    });

    const proposed = await provider.propose(requestFor(createSpecification()));
    expect(proposed).toEqual({ specification: { nonsense: true } });
    expect(() => validateRepairCandidate(createSpecification(), proposed)).toThrowError(
      MotionRepairError,
    );
  });
});
