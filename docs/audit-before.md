# تدقيق التبعيات قبل المرحلة 1 (docs/audit-before.md)

- **التاريخ (UTC):** 2026-10-27
- **البيئة:** Node v22.22.3 / npm 10.9.8 — تثبيت نظيف بـ `npm ci` (876 حزمة) قبل القياس
- **خط الأساس:** 35 ملفًا / **365 اختبارًا ناجحة** بعد التثبيت (متحقق فعليًا)
- **الأوامر:** `npm audit` و`npm audit --omit=dev` (النص الكامل والـ JSON محفوظان في أرشيف الجلسة؛ الجدولان أدناه ملخصهما المطابقان)

## النتيجة الإجمالية

`npm audit --omit=dev` = **21 مخرًجًا**: 14 عالية، 2 متوسطة، 5 منخفضة.
`npm audit` الكامل يطابق الإنتاج: **لا توجد نتائج خاصة بأدوات التطوير فقط** — كل الثغرات في شجرة تبعيات الإنتاج.

## تفصيل نتائج تبعيات الإنتاج

| الحزمة | الخطورة | النطاق الثغور | الإصلاح المقترح من npm | القرار |
| --- | --- | --- | --- | --- |
| `zod` | high | `<4.6.6` (GHSA-mrhx-c7xc-m3w5: استنزاف ذاكرة عند التحقق من مجموعات كبيرة) | ترقية كاسرة: `@remotion/lambda@4.0.7` (تراجع رئيسي) | **مرفوض** — انظر تحليل التعارض؛ الحل: `overrides` |
| 12 مخرًجًا `@remotion/*`: bundler, cli, codemods, elevenlabs, lambda, media, openai-whisper, serverless, studio, studio-protocol, studio-server, tailwind-v4 | high | «Depends on vulnerable versions of zod» — نتائج مترتبة، لا ثغرة مستقلة | تابع لإصلاح zod | تُزال آليًا بإصلاح zod |
| `dompurify` 3.2.7 (عبر `monaco-editor` 0.55.1) | high | سلسلة XSS (GHSA-v2wj-7wpq-c8vv وغيرها) | `monaco-editor@0.57.0` (كاسر بنمط 0.x) | مقبول: ترقية monaco-editor → 0.57.0 (يعرض dompurify 3.4.15) |
| `monaco-editor` | moderate | `0.54.0-dev…0.56.0-dev` | `0.57.0` | نفس الإجراء أعلاه |
| `fast-uri` 3.1.8 | moderate | `3.0.0 – 3.1.8` (4 تنبيهات: تزوير مخطط URI، خلط مضيفين…) | `fixAvailable: true` (داخل النطاقات القائمة) | `npm audit fix` غير الكاسر |
| `ai` 5.0.104 | low | `≤5.0.206` (وأيضًا 5.1-beta…6.0) | تابع لسلسلة `@ai-sdk/*` | ترقية داخل السطر 5.0.x (`^5.0.282`) |
| `@ai-sdk/react` | low | `≤2.0.208` | `2.0.285` (غير كاسر) | `npm audit fix` |
| `@ai-sdk/openai` | low | `≤2.0.109` | `2.0.136` (غير كاسر) | `npm audit fix` |
| `@ai-sdk/gateway`, `@ai-sdk/provider-utils` | low | تبعية لسلسلة ai-sdk | تُصلح بترقية `@ai-sdk/react` | تُغطى تلقائيًا |

## تحليل تعارض zod ↔ Remotion (بالتفصيل المطلوب)

**السبب: تثبيت دقيق (exact pin) لا نطاق.** من السجل (registry) فعليًا:

```
npm info @remotion/studio-protocol@4.0.534 dependencies
→ { "zod": "4.5.4" }          ← إصدار دقيق، لا نطاق
npm info @remotion/studio-protocol@latest dependencies
→ { "version": "4.0.539", "dependencies": { "zod": "4.5.4" } }
```

- سلسلة `@remotion/*` (كلها 4.0.534) تشترك في `@remotion/studio-protocol` و`@remotion/codemods`، وكلاهما **يثبّت zod على 4.5.4 بالضبط**.
- إصلاح GHSA-mrhx-c7xc-m3w5 في zod `4.6.6`+، ولأن التثبيت دقيق لا يمكن تجاوزه بالنطاقات، لا يستطيع npm وضع نسخة zod مرقّعة في نفس الشجرة دون كسر التثبيت الدقيق.
- **المسار الأول (ترقية Remotion كاملًا) مستنفد بالدليل:** أحدث إصدار على `latest` هو `4.0.539` وما زال يثبّت `zod: 4.5.4` — لا يوجد إصدار 4.0.x يقبل zod المرقّع. (dist-tags: latest=4.0.539، alpha=4.1.0-alpha12 — غير مستقر.)
- **اقتراح npm الرسمي مرفوض:** `npm audit fix --force` سيُنزّل السلسلة كلها إلى `@remotion/lambda@4.0.7` (تراجع عن 4.0.534 بمئات الإصدارات — كاسر فعليًا).
- **المسار المتبقي (المعتمد):** `overrides` في `package.json` يفرض `zod: ^4.6.7` على كل الشجرة، مع اختبار كامل + عرض فعلي للتحقق من توافق سلسلة Remotion مع zod 4.6.7. إن فشل، الخطة البديلة الموثقة: خفيف بسقوف `.max()` على المصفوفات في مخططات Zod الخاصة بالمسارات المكشوفة كتخفيف مؤقت.

> ملاحظة نطاق الاستخدام: الحزم الثلاث المثبِّتة (`studio-protocol`, `codemods`, `studio-server`) تصل عبر `@remotion/cli` و`@remotion/bundler` (أدوات بناء/استوديو)، ولا يُستوردها كود الخادم في وقت التشغيل؛ لكنها ضمن شجرة «إنتاج» لأن `@remotion/cli` و`@remotion/bundler` تبعيات إنتاج في `package.json`.
