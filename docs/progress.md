# سجل تقدّم المراحل (docs/progress.md)

> المصدر: `prompts/phase-*.md` و`CLAUDE.md`. حالة خط الأساس المُلزِم: **365 اختبارًا في 35
> ملفًا + typecheck + lint + build ناجحة**. أي مرحلة تنتهي بأقل من ذلك غير مكتملة.

| المرحلة | الحالة | آخر تحديث | ملاحظة |
| --- | --- | --- | --- |
| 0 — CI تلقائي وتنظيف المخلفات | **مكتملة** | 2026-10-27 | تفاصيل وأدلة أدناه |
| 1 — التبعيات الأمنية | **مكتملة** | 2026-10-27 | 21 ثغرة ← **0**؛ تفاصيل وأدلة أدناه |
| 2 — التحقق من المدخلات | **مكتملة** | 2026-10-27 | كل مسار يتحقق ويحدّ الحجم؛ تفاصيل وأدلة أدناه |
| 3 — المصادقة وحد المعدل | لم تبدأ | — | ⚠️ مراجعة بشرية قبل الدمج |
| 4 — عزل `new Function` | لم تبدأ | — | ⚠️ مراجعة بشرية قبل الدمج |
| 5 — الحالة المشتركة | لم تبدأ | — | |
| 6 — توحيد المعمارية والنشر | لم تبدأ | — | |
| 7 — دمج الصوت | لم تبدأ | — | |
| 8 — اختبارات شاملة ونشر ذاتي | لم تبدأ | — | |

---

## المرحلة 1 — مكتملة (2026-10-27)

### ما تغيّر

| الملف | التغيير |
| --- | --- |
| `package.json` + `package-lock.json` | `zod ^4.6.7`، `monaco-editor 0.56.0`، `ai 5.0.222`، `@ai-sdk/react 2.0.224`، `@ai-sdk/openai 2.0.116`، `google-auth-library ^11.3.1`، و`overrides` إلزامية (`zod ^4.6.7`, `dompurify 3.4.17`, `@ai-sdk/provider-utils 3.0.30`) |
| `tests/dependency-security-policy.test.ts` | جديد (7 اختبارات): يجمّد النوافذ الآمنة ويمنع التراجع — فشل 6/7 فعليًا على lockfile ما قبل المرحلة |
| `.github/workflows/ci.yml` | بوابة audit أصبحت إلزامية (`--audit-level=high` يفشل البناء) — نهاية وضع التحذير من المرحلة 0 |
| `.github/dependabot.yml` | جديد: npm + github-actions أسبوعيًا، مع تنبيه مراجعة للسلاسل المثبّتة. **ملاحظة تفعيل:** GitHub يتطلب وجود `dependabot.yml` على الفرع الافتراضي — سيعمل فعليًا بعد دمج PR #5 في `main` |
| `docs/audit-before.md` / `docs/audit-after.md` | سجل كامل قبل/بعد + تحليل التعارض + انزياح التنبيهات + ما لم يُتحقق |

### النتيجة الأمنية

`npm audit --omit=dev`: **21 (14 عالية) ← 0** · `npm audit` الكامل: **0**.
`undici` و`@fastify/busboy` محذورتان من الشجرة كليًا (كانتا ستدخلان عبر provider-utils 3.0.42).

### الأدلة — ما اختُبر فعليًا

| الأمر | النتيجة الفعلية |
| --- | --- |
| `npm audit --omit=dev` و`npm audit` بعد الإصلاح | **0 ثغرات** لكليهما ✅ |
| `npm test` | **372 اختبارًا ناجحة** (365 أساس + 7 سياسة) — 35+1 ملفًا ✅ |
| اختبار السياسة على lockfile ما قبل المرحلة | فشل **6/7** برسائل دقيقة (`zod 4.5.4 < 4.6.6`, `dompurify 3.2.7 < 3.4.17`…) ✅ |
| `npm run typecheck` / `lint` / `build` | exit 0 للجميع ✅ |
| `npm run agent:frame-smoke` | MP4 حقيقي (2s/24fps/48 إطارًا) عبر ffmpeg المرفق + بوابة ffprobe: `frameCountConsistent: true` ✅ |
| `npm run bundle:remotion` | تجميع حزمة العرض الفعلية (مع zod 4.6.7): exit 0 ✅ |
| `npm ci` نظيف بعد التعديلات | ينجح (تثبيتات متعددة أثناء ضبط النسخ) ✅ |

### ما لم يُتحقق ولماذا

- **عرض متصفح حقيقي داخل البيئة:** لا متصفح في النظام، وتنزيل Headless Shell محجوب بسياسة
  الشبكة (`remotion.media` خارج المضاحين المسموحة)، و`gh workflow run` مرفوض للرمز
  (HTTP 403). **على المالك:** تشغيل «Render smoke test (manual)` بـ `code_ref =
  arena/cc0b132c-fqmg-ohz` من تبويب Actions — عرض 2 ثانية + ffprobe على runners.
- شرط المرحلة «عرض قصير ينجح إن توفر Chromium/ffmpeg»: ffmpeg توفر (frame-smoke حقيقي)،
  وChromium لم يتوفر — لهذا بقي العرض الكامل معلقًا بتشغيل المالك.

### المخاطر المتبقية

1. النوافذ الآمنة المثبّتة بدقة ستهجر عن «الأحدث» عمدًا؛ كل PR من Dependabot على سلسلة
   ai-sdk يتطلب تحديث التثبيت + اختبار السياسة معًا (تنبيه مكتوب في dependabot.yml).
2. `overrides.zod` يفرض 4.6.7 على حزم Remotion المثبِّتة 4.5.4 — التوافق مُثبت اليوم
   (بوابات + bundle + frame-smoke) ويُعاد التحقق عند أي ترقية Remotion (المرحلة 6).
3. لم يُرَ عرض متصفح كامل على الشجرة الجديدة بعد (بانتظار تشغيل المالك — أعلاه).

---

## المرحلة 2 — مكتملة (2026-10-27)

### ما تغيّر

| الملف | التغيير |
| --- | --- |
| `src/lib/generate-request-schema.ts` | جديد: `GenerateRequestSchema` (Zod) + `GENERATE_MAX_REQUEST_BYTES = 32MB` + `GENERATE_IMAGE_LIMITS` + ميزانية صور إجمالية ≤8 + `validateGenerateRequestImages` (فحص magic bytes وأبعاد كل صورة عبر `inspectImage`) |
| `src/app/api/generate/route.ts` | المقدمة: `readBoundedJson` (32MB) ← مخطط Zod ← فحص الصور ← 400/413/415 منظمة مع `issues` و`requestId`؛ حُذف تسجيل البرومبت الكامل (مسارا البداية والمتابعة) لصالح `requestId` + `promptLength` + أعداد؛ تعمية أخطاء المصنّف والمهارات عبر `sanitizeDiagnosticText`؛ رأس `x-request-id` في استجابة البث |
| `src/helpers/api-response.ts` | عقد جديد (D-014): `readBoundedJson` بسقف قابل للضبط (افتراضي 64KB)؛ فشل المخطط ← 400 + `issues`؛ خطأ المعالج ← 500 عام + تسجيل داخلي مُعمّى |
| `src/app/api/lambda/render/route.ts` | عبر العقد الجديد بسقف 64KB |
| `src/app/api/lambda/progress/route.ts` | عبر العقد الجديد بسقف 16KB |
| `src/app/api/plan/route.ts` | توحيد على `readBoundedJson` (32KB) مع فرض `application/json` (D-016) |
| `src/hooks/useImageAttachments.ts` + `ChatInput.tsx` | مواءمة العميل: 2MB/صورة وPNG/JPEG فقط مع رسائل خطأ واضحة (UX فقط — الخادم هو الحد الفعلي) |
| `tests/generate-route-validation.test.ts` | جديد (9): 413/415/400 JSON/مخطط/صور (نوع، magic bytes، حجم، ميزانية إجمالية) + نظافة اللوج (لا برومبت + `promptLength` + `requestId`) |
| `tests/api-response-helpers.test.ts` | جديد (6): عقد `executeApi` كاملًا |
| `tests/api-plan-route.test.ts` | جديد (4): معالج `/api/plan` نفسه (استدعاء المسار) |
| `tests/lambda-routes-validation.test.ts` | جديد (4): مسارَا Lambda عبر العقد الجديد |
| `vitest.config.ts` | إضافة مُحوّل `raw-markdown` (يحاكي raw-loader الخاص بـ Next لمسارات `@/skills` داخل Vitest) |
| `docs/api-validation.md` | جديد: جدول تحقق كل المسارات + عقد `executeApi` + سياسة اللوج |

### الأدلة — ما اختُبر فعليًا

| الأمر | النتيجة الفعلية |
| --- | --- |
| الاختبارات الجديدة قبل التنفيذ | **18 فشلًا / 5 نجاح** (إثبات يفشل-أولًا؛ اختبارات `/api/plan` الأربعة نجحت لأن المسار كان يتحقق أصلًا — وهي تغطية جديدة مطلوبة) |
| `npm test` بعد التنفيذ | **395 اختبارًا ناجحًا في 40 ملفًا** (كانت 372) ✅ |
| `npm run typecheck` / `npm run lint` | exit 0 للجميع ✅ |
| `npm run build` | exit 0 (بنفس تحذيري Turbopack القديمَين) ✅ |
| فحص السجلات يدويًا | `grep` على `src/app/api/`: لا توجد أسطر تسجيل تحتوي البرومبت أو الكود؛ الثلاثة المتبقية أسماء مهارات/سجلات مهيكلة ✅ |

### ما لم يُتحقق ولماذا

- تدفق `/api/generate` الكامل مع مزود حقيقي (بث فعلي): يتطلب مفتاح نموذج متاحًا في البيئة —
  الاختبارات تستخدم mocks للمسار/الـ AI عمدًا وتستهدف حد الطلب لا المزود.
- لا تغطية E2E للمتصفح في هذه المرحلة (مواءمة العميل تحقق بالمراجعة والـ typecheck؛
  اختبارات مكونات UI مؤجلة للمرحلة 8 وفق الخطة).

### المخاطر المتبقية

1. `/api/generate` يبقى مفتوحًا بلا مصادقة/حد معدل: السقوف تحد من حجم الطلب الواحد لكن
   **تكلفة المزود عبر طلبات متكررة غير محدودة حتى المرحلة 3** — أولوية قصوى تالية.
2. قيم السقوف (32MB للجسم، 2MB/صورة، ≤8 صور) اختيارات موثقة قابلة للضبط عبر ملف واحد
   (`generate-request-schema.ts`)؛ قد تحتاج ضبطًا بعد قياس الاستخدام الفعلي.
3. `attachedImages` في سجل المحادثة تُفحص كالصور الحالية — يزيد زمن المعالجة قليلًا
   (فحص ترويسات فقط).

---

## المرحلة 0 — مكتملة (2026-10-27)

### ما تغيّر

| الملف | التغيير |
| --- | --- |
| `.github/workflows/ci.yml` | جديد: بوابات تلقائية على `push` و`pull_request` — `npm ci`، typecheck، lint، `test:coverage` (رفع تقرير HTML)، `next build`، `npm audit --omit=dev` (رفع تقرير JSON). |
| `vitest.config.ts` | تفعيل التغطية (مزود v8، تقارير text/text-summary/html، نطاق `src/**`، بلا عتبات — قرار موثق). |
| `package.json` + lockfile | سكربت `test:coverage` وتبعية تطوير `@vitest/coverage-v8@5.0.3` (مطابقة إصدار vitest 5.0.3). |
| `scripts/_tmp_gates.mjs` | حُذف: مسارات Windows صلبة (`D:\07_Programming\...`) وإخراج في `%TEMP%` لجهاز بعينه. |
| `tailwindcss-21332.log` | حُذف: لوج شارد فارغ في الجذر. |
| `.gitignore` | نمط `*.log`. |
| `eslint.config.mjs` | إزالة تكرار مدخل `".agents/**"`. |
| `tsconfig.json` | إزالة `paths.react` → `../../node_modules/@types/react` (خارج المشروع). |
| `CLAUDE.md`, `prompts/phase-0..8.md` | تثبيت تعليمات المالك وخطة المراحل داخل المستودع (مع الإبقاء على `@AGENTS.md`). |
| `docs/decisions.md` | قرارات D-001…D-006 الخاصة بالمرحلة. |
| `docs/branch-protection.md` | خطوات إلزام فحص `gates` على `main` (عمل المالك — غير مُطبَّق آليًا). |

### الأدلة — ما اختُبر فعليًا (أوامر ونتائجها في بيئة العمل)

| الأمر | النتيجة الفعلية |
| --- | --- |
| `npm test` (بعد التعديلات) | `35 passed (35)` / `365 passed (365)` — لا تراجع عن خط الأساس ✅ |
| `npm run typecheck` | exit 0 (بعد إزالة مسار react الخارجي) ✅ |
| `npm run lint` | exit 0 (بعد إزالة التكرار) ✅ |
| `npm run test:coverage` | exit 0 — تغطية: **Statements 66.1% · Branches 61.37% · Functions 57.9% · Lines 67.73%** (سُجّلت للمرحلة 8)، وتقرير HTML في `coverage/` ✅ |
| `npm run build` | exit 0 (بنفس تحذيري Turbopack المعروفَين مسبقًا حول `src/render/engine/render-job.ts` — قديمان وغير من هذه المرحلة) ✅ |
| بناء من نسخة نظيفة | worktree منفصل عند رأس الفرع `f5a1c49`: `npm ci` (876 حزمة) ثم `npm run build` — exit 0 ✅ |
| CI على push | run [`40539442082`](https://github.com/mamourgroupe-ctrl/fqmg-ohz/actions/runs/40539442082): **success** (1m49s) ✅ |
| CI على pull_request | run [`40539467134`](https://github.com/mamourgroupe-ctrl/fqmg-ohz/actions/runs/40539467134): **success** (1m43s)، فحص `gates` = pass على PR #5، مع تنبيه `::warning::` الخاص بوضع audit التحذيري كما هو مصمَّم ✅ |
| `npm audit --omit=dev` (محلي) | 21 ثغرة (5 low, 2 moderate, **14 high**): `zod 4.5.4` (GHSA-mrhx-c7xc-m3w5)، `dompurify` عبر `monaco-editor`، `fast-uri`، سلسلة `@remotion/*` — سُجّلت في قرار D-002 |

### ما استُنتج من القراءة (لم يُختبر فعليًا)

- عمل حماية الفرع نفسها بعد التطبيق: موصوف في `docs/branch-protection.md` ولم يُطبَّق
  (يتطلب صلاحية admin — قرار D-005)، لذا «رفض الدمج بفحص أحمر» استنتاج من توثيق GitHub لا تجربة.
- خطوة audit داخل CI ترفع التقرير كأثر نجحت (اسم الخطوة ظاهر في سجل التشغيل)، لكن محتوى
  ملف `audit-prod.json` المرفوع لم يُنزَّل وفُحص محليًا.
- Dependabot/Renovate ليست في نطاق المرحلة 0 (مطلوبة في المرحلة 1).

### المخاطر المتبقية بعد المرحلة 0

1. ثغرات تبعيات الإنتاج (14 عالية) ما زالت قائمة — البوابة في وضع تحذيري موثق (D-002) حتى المرحلة 1.
2. حماية `main` غير مطبقة فعليًا: لا يمنع أحد اليوم الدمج المباشر المتجاوز للبوابات (D-005).
3. التغطية مقيسة بلا عتبات؛ فرضها مؤجل إلى المرحلة 8 عن قصد.
4. كل المراحل تتراكم على فرع الجلسة الواحد بدل فرع لكل مرحلة (قيد منصة Arena — D-001)؛
   PR #5 مسودة وستراكم المراحل القادمة commits، والمراجعة البشرية للمرحلتين 3 و4 تبقى إلزامية.
