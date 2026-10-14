export function isExplicitArabicAnimationRequest(prompt: string): boolean {
  const normalized = prompt
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
  const hasCreationAction =
    /(?:^|[\s،,.!?؟])(?:اكتب|ارسم|صمم|انشئ|اعمل|اعملي|سوي|حرك|اجعل|خلي)(?=$|[\s،,.!?؟])/u.test(
      normalized,
    );
  const hasAnimationCue =
    /انيميشن|انميشن|رسوم متحرك|متحرك|حركه|مقدمه|افتتاحيه|شعار|لوجو|فيديو|مشهد|لقطه|اعلان|بطاقه|واجهه/u.test(
      normalized,
    );

  return hasCreationAction && hasAnimationCue;
}
