import { describe, expect, it } from "vitest";
import { isExplicitArabicAnimationRequest } from "@/helpers/prompt-validation";

describe("isExplicitArabicAnimationRequest", () => {
  it("accepts direct Arabic animation requests", () => {
    expect(isExplicitArabicAnimationRequest("اكتب مرحبا بالانميشن")).toBe(true);
    expect(
      isExplicitArabicAnimationRequest("صمّم رسومًا متحركة لكلمة مرحبًا"),
    ).toBe(true);
    expect(
      isExplicitArabicAnimationRequest("صمّم لي مقدمة جذابة لقناتي"),
    ).toBe(true);
  });

  it("does not treat informational Arabic questions as animation requests", () => {
    expect(isExplicitArabicAnimationRequest("ما معنى الأنيميشن؟")).toBe(false);
    expect(isExplicitArabicAnimationRequest("ترجم كلمة أنيميشن")).toBe(false);
  });
});
