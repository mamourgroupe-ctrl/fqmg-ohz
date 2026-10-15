import { describe, expect, it } from "vitest";
import { getNextCorrectionAttempt } from "@/hooks/useAutoCorrection";
import type { ErrorCorrectionContext } from "@/types/conversation";

const correction = (
  error: string,
  attemptNumber: number,
): ErrorCorrectionContext => ({
  error,
  attemptNumber,
  maxAttempts: 3,
});

describe("getNextCorrectionAttempt", () => {
  it("allows up to three attempts when the error changes", () => {
    expect(getNextCorrectionAttempt("error one", null, 3)).toBe(1);
    expect(
      getNextCorrectionAttempt("error two", correction("error one", 1), 3),
    ).toBe(2);
    expect(
      getNextCorrectionAttempt("error three", correction("error two", 2), 3),
    ).toBe(3);
    expect(
      getNextCorrectionAttempt("error four", correction("error three", 3), 3),
    ).toBeNull();
  });

  it("stops when the same error repeats twice", () => {
    expect(
      getNextCorrectionAttempt("same error", correction("same error", 1), 3),
    ).toBe(2);
    expect(
      getNextCorrectionAttempt("same error", correction("same error", 2), 3),
    ).toBeNull();
  });
});
