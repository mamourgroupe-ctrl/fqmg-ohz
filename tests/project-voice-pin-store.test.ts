import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectVoicePinStore, VoicePinStoreError } from "@/voice/state/project-voice-pin-store";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeStore(): { directory: string; store: ProjectVoicePinStore } {
  const directory = mkdtempSync(path.join(tmpdir(), "fqmg-project-voice-pin-test-"));
  temporaryDirectories.push(directory);
  return { directory, store: new ProjectVoicePinStore(directory) };
}

function selection(providerId: "azure-speech" | "openai", voiceId: string) {
  return {
    providerId,
    voiceId,
    voiceName: `Fixture ${voiceId}`,
    modelId: `${providerId}-fixture-model`,
    languageTag: "en-US",
    matchedLocaleTag: "en-US",
    capabilityConfidence: "exact-locale-inventory" as const,
    selectedAt: "2026-10-09T12:00:00.000Z",
  };
}

describe("ProjectVoicePinStore", () => {
  it("persists a validated provider/voice pin and reloads it in a new store instance", async () => {
    const { directory, store } = makeStore();
    const pinned = selection("azure-speech", "fixture-voice");

    await store.set("project-1", pinned);

    expect(await store.get("project-1")).toEqual(pinned);
    expect(await new ProjectVoicePinStore(directory).get("project-1")).toEqual(pinned);
    const storedText = readFileSync(path.join(directory, "project-voices.json"), "utf8");
    expect(storedText).not.toContain(directory);
  });

  it("serializes project pin updates without losing writes for other projects", async () => {
    const { store } = makeStore();
    await Promise.all([
      store.set("project-a", selection("azure-speech", "voice-a")),
      store.set("project-b", selection("openai", "voice-b")),
      store.set("project-c", selection("azure-speech", "voice-c")),
    ]);

    expect((await store.get("project-a"))?.voiceId).toBe("voice-a");
    expect((await store.get("project-b"))?.voiceId).toBe("voice-b");
    expect((await store.get("project-c"))?.voiceId).toBe("voice-c");
  });

  it("serializes work for one project while allowing subsequent requests to reuse the pin", async () => {
    const { store } = makeStore();
    const executionOrder: string[] = [];

    await Promise.all([
      store.runExclusive("project-serial", async () => {
        executionOrder.push("first-start");
        await new Promise((resolve) => setTimeout(resolve, 10));
        await store.set("project-serial", selection("azure-speech", "first"));
        executionOrder.push("first-end");
      }),
      store.runExclusive("project-serial", async () => {
        executionOrder.push("second-start");
        expect((await store.get("project-serial"))?.voiceId).toBe("first");
        executionOrder.push("second-end");
      }),
    ]);

    expect(executionOrder).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });

  it("fails closed on corrupt persisted data and invalid project IDs", async () => {
    const { directory, store } = makeStore();
    await store.set("project-valid", selection("openai", "voice-safe"));
    const filePath = path.join(directory, "project-voices.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, "{ not valid JSON");

    await expect(store.get("project-valid")).rejects.toBeInstanceOf(VoicePinStoreError);
    await expect(store.get("../escape")).rejects.toBeInstanceOf(VoicePinStoreError);
  });
});
