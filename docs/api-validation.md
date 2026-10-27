# جدول التحقق من مدخلات كل مسارات API (docs/api-validation.md)

> **المرحلة 2.** كل مسار يتحقق من مدخلاته ويحدّ حجم الجسم قبل أي معالجة، وأخطاء التحقق تعيد
> 400 مع `issues` منظمة ولا تُسرّب رسائل داخلية خام، ولا يُسجَّل برومبت المستخدم في اللوج
> (يُسجَّل طول فقط + `requestId`). اختبارات الحدود في `tests/` (عمود «الاختبار»).

| المسار | الطريقة | مخطط التحقق | سقف الجسم | خريطة الأخطاء | الاختبار |
| --- | --- | --- | --- | --- | --- |
| `/api/generate` | POST | `GenerateRequestSchema` (`src/lib/generate-request-schema.ts`): برومبت ≤16k حرف، كود ≤120k، سجل ≤12 رسالة ≤20k، صور ≤4 حالية و≤8 إجمالًا، `excludedModels` ≤16 | **32 MB** عبر `readBoundedJson` + فحص كل صورة (magic bytes + أبعاد ≤4096px + ≤2MB) عبر `inspectImage` | 413 كبير / 415 نوع المحتوى / 400 JSON أو مخطط أو صورة / 400 مع `issues` | `tests/generate-route-validation.test.ts` |
| `/api/plan` | POST | `DirectorRequestSchema` | **32 KB** عبر `readBoundedJson` | 413 / 415 / 400 JSON / 400 مع `issues` / 500 عام | `tests/api-plan-route.test.ts` |
| `/api/voice/providers` | GET | `LanguageTagSchema` على `languageTag` (افتراضي `ar-DZ`) — `includeVoices` محصور، وكل مزود ≤100 صوت | لا جسم (GET) | 400 / 500 عام | `tests/voice-api.test.ts` |
| `/api/voice/synthesize` | POST | `VoiceSynthesisApiRequestSchema` | **1 MB** عبر `readBoundedJson` | 400/413/415 + أكواد محرك الصوت (`VoiceApiErrorSchema`) | `tests/voice-api.test.ts` |
| `/api/voice/audio/{id}` | GET | مرجع صوتي معتم؛ يُقرأ عبر ذاكرة الصوت المُدارة فقط (لا مسار ملفات من العميل) | لا جسم (GET) | 404 لغير الموجود | `tests/voice-api.test.ts` |
| `/api/agent/qa` | POST | `AgentQaRequestSchema` | **128 KB** (`AGENT_QA_MAX_REQUEST_BYTES`) عبر `readBoundedJson` | 400/413/415/409 مكرر/429 سعة | `tests/agent-job-api.test.ts` |
| `/api/agent/qa/{jobId}` | GET / DELETE | `jobId` يجب أن يكون UUID؛ لا جسم | — | 404 / 409 | `tests/agent-job-api.test.ts` |
| `/api/agent/qa/{jobId}/preview` | GET | `jobId` UUID + حصر المسار داخل الجذور المسموحة (`assertPathWithinRoots`)؛ لا يُكشف مسار نظام الملفات أبدًا | — | 404/403/409 | `tests/agent-job-api.test.ts`, `tests/agent-artifact.test.ts` |
| `/api/lambda/render` | POST | `RenderRequest` عبر `executeApi` | **64 KB** | 400 مع `issues` / 413 / 415 / 500 عام (التفاصيل في اللوج مُعمّاة) | `tests/lambda-routes-validation.test.ts` |
| `/api/lambda/progress` | POST | `ProgressRequest` عبر `executeApi` | **16 KB** | 400 مع `issues` / 413 / 415 / 500 عام | `tests/lambda-routes-validation.test.ts` |

## عقد `executeApi` (منذ المرحلة 2)

1. الجسم عبر `readBoundedJson`: أكبر من السقف ← **413**، نوع محتوى غير JSON ← **415**،
   JSON تالف ← **400**.
2. فشل المخطط ← **400** مع `{ type: "error", message, issues: [{ path, message }] }` —
   بدون تقرير Zod الخام.
3. خطأ المعالج ← **500** برسالة عامة `"Unexpected server error."`؛ الخطأ الحقيقي يُسجَّل
   داخليًا عبر `sanitizeDiagnosticText` (إخفاء أسرار + اختصار المسارات المطلقة).
4. مسار الاستجابة الناجح دون تغيير: `{ type: "success", data }` (متوافق مع `src/lambda/api.ts`).

## تسجيل السجلات في `/api/generate`

- كل طلب يحمل `requestId` (UUID) يظهر في الاستجابة (`x-request-id`) وفي كل سطور السجل.
- ما يُسجَّل عن المستخدم: **طول** البرومبت، عدد الصور، عدد المهارات، الموديل — **لا يُسجَّل
  نص البرومبت أو الكود أو محتوى الصور إطلاقًا** (اختبار يتحقق: `tests/generate-route-validation.test.ts`).
- أخطاء المزودين تُعمَّى عبر `sanitizeDiagnosticText` قبل التسجيل.

## حدود جهة العميل (UX فقط — ليست حدودًا أمنية)

`useImageAttachments`: ≤4 صور، ≤2MB للصورة، وPNG/JPEG فقط (`accept` في `ChatInput` محصور
كذلك) — مطابقة عمدًا لحدود الخادم في `GENERATE_IMAGE_LIMITS`؛ الخادم يتحقق فعلًا بالبايتات
الحقيقية ولو تجاوز العميل.
