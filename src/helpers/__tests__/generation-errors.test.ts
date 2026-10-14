import { describe, expect, it } from "vitest";
import {
  getGenerationHttpErrorMessage,
  getGenerationStreamErrorMessage,
  getSafeProviderErrorMessage,
  parseGenerationStreamEvent,
} from "@/helpers/generation-errors";

describe("generation stream errors", () => {
  it("parses successful UI message stream events", () => {
    expect(
      parseGenerationStreamEvent(
        JSON.stringify({ type: "text-delta", delta: "const code = true;" }),
      ),
    ).toEqual({ type: "text-delta", delta: "const code = true;" });
    expect(parseGenerationStreamEvent("[DONE]")).toBeNull();
  });

  it("preserves a streamed error message", () => {
    expect(getGenerationStreamErrorMessage("Provider unavailable")).toBe(
      "Provider unavailable",
    );
    expect(
      getGenerationStreamErrorMessage({ errorText: "Provider unavailable" }),
    ).toBe("Provider unavailable");
    expect(
      getGenerationStreamErrorMessage({ message: "Request was rejected" }),
    ).toBe("Request was rejected");
  });

  it("provides a clear fallback for missing or non-text stream errors", () => {
    const fallback =
      "The AI provider ended the generation without a usable error message. Check its availability and configuration, then retry.";
    expect(getGenerationStreamErrorMessage(undefined)).toBe(fallback);
    expect(getGenerationStreamErrorMessage({ code: 401 })).toBe(fallback);
  });

  it("reads API error messages and falls back to the HTTP status", () => {
    expect(
      getGenerationHttpErrorMessage({ error: "Request rejected" }, 503),
    ).toBe("Request rejected");
    expect(getGenerationHttpErrorMessage({ error: { code: "offline" } }, 503)).toBe(
      "Generation request failed (HTTP 503).",
    );
    expect(getGenerationHttpErrorMessage(null, 503)).toBe(
      "Generation request failed (HTTP 503).",
    );
  });

  it("maps provider HTTP failures to safe, actionable messages", () => {
    expect(
      getSafeProviderErrorMessage({
        message: "User not found.",
        statusCode: 401,
      }),
    ).toBe(
      "The AI provider rejected the configured account (HTTP 401). Verify the provider endpoint, account access, and selected model.",
    );
    expect(getSafeProviderErrorMessage({ status: 404 })).toBe(
      "The AI provider could not find the selected model or endpoint (HTTP 404). Verify the provider configuration.",
    );
  });
});