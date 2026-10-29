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

## المرحلة 3 — مكتملة (بانتظار مراجعة بشرية قبل الدمج ⚠️)

**بوابات الجودة (فعلية، محليًا):** `npm test` → **424/424** (44 ملفًا؛ كان 395)،
`npm run typecheck` → 0، `npm run lint` → 0، `npm run build` → 0، تدقيق الإنتاج → 0.

**ما نُفذ:**
1. بوابة خارجية `src/proxy.ts` (بديل middleware في Next 16): كل `/api/*` تتطلب جلسة
   موقّعة؛ العامة = login/logout فقط؛ `ip-global` 120/د لكل IP قبل فحص الجلسة.
2. نواة `src/auth/`: `session.ts` (HMAC كوكي موقّع، `FQMG_USERS` scrypt، `requireUser()`،
   فشل مغلق بلا `AUTH_SECRET`)، `rate-limit.ts` (10 سياسات لكل مستخدم/IP عبر واجهة
   `RateLimitStore`، `__resetRateLimitsForTests()`)، `guard.ts` (`authenticateApiRequest`
   + `forbiddenResponse()`)، `ownership.ts`.
3. تسجيل الدخول/الخروج: `POST /api/auth/login` (حد 5/5د لكل IP، رسالة عامة واحدة،
   كوكي HttpOnly/Lax/Secure-في-الإنتاج، 12 ساعة) و`POST /api/auth/logout`.
4. كل مسار API مدفوع/حساس محمي: generate، plan، voice×3، qa POST/GET/DELETE/preview،
   lambda render/progress (عبر `executeApi` بمصادقة قبل قراءة الجسم + `ratePolicy`).
5. تفويض لكل مورد: مهام QA مملوكة (403 للمستخدم الآخر)، المعاينة تتحقق قبل كشف الوجود،
   الصوت fail-closed لمرجع بلا مالك، dedupe الـ qa لكل مستخدم.
6. ميزانية لكل مستخدم: `AGENT_USER_DAILY_BUDGET_USD` (افتراضي = السقف العام) مع
   حجز/تسوية/استرداد لكل مهمة تحمل `user`.
7. `.env.example` موثّق، `npm run auth:hash`، README محدّث، `docs/api-access.md`
   (جدول المسارات × الهوية × الحدود)، D-017..D-020.

**الاختبارات الجديدة (كتبت حمراء أولًا):** `tests/api-auth.test.ts` (18)،
`tests/api-authorization.test.ts` (4)، `tests/api-rate-limit.test.ts` (4)،
`tests/agent-budget-per-user.test.ts` (3)، `tests/api-proxy.test.ts` (4) = 29 اختبارًا.
إجمالي 395 → 424 (لا يوجد اختبار محذوف). أُثبت: 401 بلا جلسة/بكوكي مزيّف، 403 عابر
للمستخدمين (حالة/إلغاء/معاينة/صوت)، 429 + `Retry-After` + تصفير النافذة + عزل
المستخدمين/IPs، رفض الميزانية لكل مستخدم دون المساس بحصة الآخرين، فشل مغلق
(`AUTH_SECRET` مفقود، صوت بلا مالك).

**ملاحظات معمارية:** (أ) تعطيل `AUTH_ENABLED=0` يلغي المصادقة والتفويض وحد المعدل
معًا (D-018)؛ (ب) الحد والميزانية process-local — المرحلة 5 تستبدل المخزن بـ Redis
(D-019)؛ (ج) next-auth@beta رُفض لصالح جلسات داخلية (D-017) — **قرار يحتاج موافقة
المالك**؛ (د) لا صفحة دخول في الواجهة بعد (المرحلة 8).

**⚠️ مطلوب مراجعة بشرية صريحة قبل الدمج (شرط المرحلة 3):** راجع خصوصًا
`src/auth/session.ts` و`src/proxy.ts` و`docs/api-access.md` وD-017.

## المرحلة 4 — مكتملة (بانتظار مراجعة بشرية قبل الدمج ⚠️)

**بوابات الجودة (فعلية، محليًا):** `npm test` → **476/476** (46 ملفًا؛ كان 428)،
`npm run typecheck` → 0، `npm run lint` → 0، `npm run build` → 0 (14 صفحة)،
تدقيق الإنتاج → 0. الاعتماديات: **صفر تغيير** (package.json/package-lock
مطابقان للمرحلة 3).

**ما نُفذ:**
1. بوابة تحقق AST فاشلة-مغلقة `src/sandbox/code-validator.ts` — قائمة بيضاء
   للمعرفات (حقن React/Remotion + builtins حتمية + أنواع TS)، رفض
   `import()`/import/with، رفض أسماء أعضاء الهروب (constructor/__proto__/
   prototype/caller/callee)، رفض الوصول المحسوب غير الحرفي، رفض الإسناد
   لمعرف عالمي. تُعيد مخالفات (kind:name) بلا مقاطع شيفرة خام.
2. عقد الإطار `src/sandbox/iframe-sandbox.ts` — `sandbox="allow-scripts"` بلا
   `allow-same-origin`، ثابت CSP بلا شبكة، حارس بنيوي للرسائل (أنواع معلومة،
   حقول مضبوطة، رفض __proto__/constructor)، و`isTrustedSandboxEvent` (الأصل
   "null" فقط + المصدر = نافذة الإطار).
3. جسر بحقن التبعيات `src/sandbox/sandbox-bridge.ts` — كلب مهلة readiness،
   جلسات (بدء/موت/تجاهل الرسائل المتأخرة)، وقناة التقاط إطار بمعرفات مرتبطة
   ومهلة مستقلة.
4. `src/sandbox/SandboxedPreview.tsx` (الأب) + `src/app/preview-sandbox`
   (داخل الإطار: تقييم + Player + التقاط عبر renderStillOnWeb داخل المعزول) +
   `src/sandbox/sandbox-runtime.ts` (بوابة التقييم: تحقق → ترجمة → تقييم).
5. إزالة التنفيذ من سياق الصفحة: useAnimationState يترجم فقط (بلا new
   Function)، /generate و/code-examples عبر SandboxedPreview، التقاط الإطار
   للشات صار طلبًا داخل المعزول (ChatSidebar/ChatInput)، AnimationPlayer
   موسوم legacy وغير مستخدم، وترويسة CSP في next.config.js لـ /preview-sandbox
   (اختبار يزامنها مع الثابت).
6. compiler.ts: `transpileGeneratedCode` (تحقق+ترجمة بيانات فقط) + تقييم موحد
   `evaluateTranspiled`؛ compileCode (سياق العرض فقط) صار خلف البوابة وموسومًا.

**الاختبارات الجديدة (حمراء أولًا — 0 موجودة قبل الوحدات):**
`tests/generated-code-sandbox.test.ts` = **48 اختبارًا**: 21 عينة هجوم
(document.cookie، fetch خارجي، XHR، WebSocket، localStorage/sessionStorage،
window.parent/top/opener، eval، Function، import() الديناميكي، import statement،
with، هروب constructor/المحسوب، إسناد عالمي، globalThis، navigator، indexedDB)
كلها تُرفض قبل التنفيذ مع اسم المخالفة؛ الشيفرة السليمة تعمل؛ لا تسريب مقاطع
مصدر في المخالفات؛ القائمة البيضاء بلا فتحات هروب؛ عقد الإطار (بلا
allow-same-origin، CSP بلا شبكة وunsafe-eval محصور بالمعزول)؛ حارس الرسائل
يرفض الوظائف/الأنواع الخاطئة/المفاتيح العدائية؛ الأصل غير "null" أو مصدر مغاير
يُهمَل؛ الكلب يموت بعد المهلة ويتجاهل المتأخرات؛ الالتقاط يرتبط بالمعرف
ويفشل بمهلة؛ بوابة التقييم ترفض `globalThis.__fqmg_pwned` دون تنفيذه؛
تطابق CSP بين next.config.js والثابت. **الإجمالي 428 → 476 (لا اختبار محذوف).**

**مختبَر فعليًا vs مستنتَج/غير مختبَر:**
- **مختبَر آليًا:** كل ما فوق — طبقات نقية في بيئة node.
- **مستنتَج (سلوك منصة موثق، غير مختبَر هنا):** إسكاد المتصفح للأصل المعتم
  (لا كوكيز/تخزين/DOM-أب) وتنفيذ CSP في المتصفح — jsdom/Playwright غير
  متاحين دون خرق سياسة الاعتماديات (D-023).
- **غير مختبَر:** سيناريو المعاينة بصريًا في متصفح حقيقي (لا Chromium في
  البيئة)، وجودة UX بعد التبديل — **تتطلب مراجعة يدوية**.

**⚠️ مطلوب مراجعة بشرية صريحة قبل الدمج (شرط المرحلة 4):** جرّب /generate
في متصفح حقيقي (المعاينة داخل الإطار المعزول + التقاط الإطار للشات)، وراجع
`src/sandbox/code-validator.ts` و`src/app/preview-sandbox/page.tsx` وD-021..D-023.

## المرحلة 5 — مكتملة

**بوابات الجودة (فعلية، محليًا ضد Redis حقيقي 8.2.3 على 6399):**
`npm test` (بـ FQMG_REQUIRE_REDIS_TESTS=1) → **491/491** (48 ملفًا؛ كان 476)،
`npm run typecheck` → 0، `npm run lint` → 0، `npm run build` → 0 (14 صفحة)،
`npm audit --omit=dev` → 0، `npm audit` → 0. اعتماديات: +`redis@6.3.1` فقط.

**ما نُفذ:**
1. `BudgetBackend` بتنفيذين — محلي (دلالات المرحلة 3 مستخرجة كما هي) وRedis
   ذرّي (Lua للحجز/التسوية/الإفلات، micro-USD، TTL 48 ساعة/يوم و24 ساعة/حجز
   مهجور). `BudgetLedger` أضحى مفوّضًا غير متزامن موحّد السطح؛ الرسائل وصيغها
   لم تتغير بين الخلفيتين.
2. `JobStateStore` Redis: مرآة سجل المهام (الحالة والنتيجة بلا
   `AbortController`)، فهرس dedupe مشترك يمنع الطلب النشط المكرر **عبر
   النسختين**، علم إلغاء عابر للنسخ يعبَّأ كل 1.2 ثانية، مرآة التقدم
   مقننة (~2 كتابة/ثانية لكل مهمة).
3. `VoiceObjectStore`: FS محلي + S3-compatible بموقّع SigV4 داخل المستودع
   مثبّت على متجه AWS الرسمي؛ الكتابة الحصرية بـ If-None-Match؛ الكاش يقرأ
   الحقول والمكانية من المخزن فيصبح قابلًا للمشاركة.
4. fail-closed موثق ومختبر: مخزن مُعدّ وغير متاح ⇒ `store-unavailable` مع
   رفض الطلب المدفوع؛ بلا `FQMG_REDIS_URL` يبقى السلوك المحلي.
5. CI: خدمة `redis:7` + `FQMG_REQUIRE_REDIS_TESTS=1` (الخادم غير المتاح =
   فشل، لا تخطٍّ) و`FQMG_TEST_REDIS_URL`.
6. `.env.example`: FQMG_REDIS_URL / FQMG_SHARED_NAMESPACE / VOICE_CACHE_STORE
   / FQMG_S3_* (قيم فارغة)، README وسطر حدود docs/api-access.md محدّثان.

**الاختبارات (حمراء أولًا ضد وحدات غير موجودة):** tests/shared-state.test.ts
(10) + tests/voice-object-store.test.ts (5) = 15 جديدة. الإجمالي 476 → 491
(لا اختبار محذوف). أُثبت فعليًا: بقاء الحجز عبر إعادة تشغيل، ذرّية حجزين
متوازيين (واحد فقط يفوز، 3 جولات)، سقف كل مستخدم عبر النسختين، رفض
المكرر النشط عبر النسختين، إلغاء عابر للنسختين، fail-closed، البقاء الافتراضي
المحلي، تكامل runtime، عقد مخزني الصوت بالكتابة الحصرية، ومتجه SigV4.

**تحقق إضافي بطلب المالك — عمليتان Node حقيقيتان:** tests/two-process-shared-state.test.ts
(3 اختبارات) تشغّل `tsx scripts/shared-state-worker.mts` كعملتي Node منفصلتين
(spawn) تتنسقان **حصرًا عبر Redis**: الحجز المتوازي عبر العمليتين (فائز واحد
فقط، جولتان)، رفض الطلب المكرر النشط في العملية الثانية بينما مهمة الأولى
تكمل طبيعيًا، وإلغاء تصدره العملية B فيُجهَض تنفيذ العملية A. أُضيف إلى CI
تلقائيًا (نفس علم FQMG_REQUIRE_REDIS_TESTS=1 يجعل تعذر الخادم فشلًا لا تخطيًا).
الإجمالي بعدها: **494/494**.

**مختبَر فعليًا vs مستنتَج/غير مختبَر:**
- **مختبَر:** كل ما سبق ضد خادم Redis 8.2.3 حقيقي — وعلى مستوى أعمق: عمليتا
  Node منفصلتان فعليًا (spawn) تتنسقان عبر Redis فقط، ما يقارب نشر نسختين.
  SigV4 ضد متجه AWS الموثق، وS3 ضد خادم stub يحاكي GET/PUT/If-None-Match.
- **غير مختبَر (مفصول):** نشر فعلي بنسختي process منفصلتين (الاختبار يحاكيهما
  داخل العملية الواحدة)، حاوية/نقطة نهاية S3 حقيقية (AWS/MinIO) — التواقيع
  مثبتة بالمتجه الرسمي لكن القراءة/الكتابة من مزود حقيقي تحتاج بيانات اعتماد
  المالك، وسلوك الكشف/التنظيف الدوري لـ TTL الفعلي (المهام تنتهي بـ TTL
  Redis؛ تنظيف الملفات المحلية يبقى دورة prune الحالية).

## المرحلة 6 — توحيد البنية وفصل النشر (جارية)

**الالتزام A (e8ef793) — فصل النشر عن البناء:**
- `vercel.json`: `next build` فقط (لا remotion) — نشر Vercel لا ينتج أي أصل خارجي.
- `scripts/deploy.mjs`: `--mode deploy` يتطلب المفاتيح ويفشل فورًا (exit 1) برسالة
  صريحة عند غيابها؛ `--mode verify` (الافتراضي) للتحقق بلا نشر.
- اسم الموقع الفعلي `fqmg-ohz` في `config.mjs` (بدل my-next-app)، وكل نقاط
  الدخول (`deploy:lambda`, `remotion`, `render`, `studio`, `bundle`) تستهدف
  `src/remotion/entry.tsx` (FQMG-OHZ-Preview، data-only). `npm run render`
  ينتج `renders/animation.mp4`.

**الالتزام B (81b0592) — حذف شيفرة التركيب القديم (نظرة grep أُريت للمالك قبل التنفيذ):**
- 15 ملفًا حُذفت (‑1097 سطرًا): Root.tsx/DynamicComp.tsx، `compileCode` من
  compiler.ts (لم يبقَ أي `new Function` خارج sandbox المرحلة 4)، مسارا HTTP
  `/api/lambda/render|progress` + `src/lambda/api.ts` + `use-rendering.ts` +
  مكونات AnimationPlayer غير المركّبة + `types/{schema,constants}.ts` +
  سياستا Rate القديمتان.
- التغطية حُفظت بإعادة التوجيه لا بالحذف: `fixCommonSyntaxErrors` عبر
  `transpileGeneratedCode`؛ اختبار المرحلة 4 أثبت انتهاء المقيّم القديم
  واستمرار مسار البيانات في sandbox المعزول end-to-end؛ api-auth يثبت أن وحدة
  المسار المحذوفة لا يمكن استيرادها أصلًا. الجرد 494 → 491 (7 اختبارات
  لمسارات محذوفة، موثقة في D-025). لا حذف صامت للتغطية.
- فحص متبقٍ: grep على كل الرموز المحذوفة = إشارات تاريخية في الوثائق فقط.

**اختبار تكامل المسار الموحد مع بوابة ffprobe (tests/render-unified-pipeline.test.ts):**
- يقود القالب الحقيقي عبر المسار الإنتاجي كاملًا: MotionSpecificationSchema →
  RemotionLocalRenderBackend (bundle لـ entry.tsx + اختيار FQMG-OHZ-Preview)
  → `verifyRenderOutput` — بوابة ffprobe الإنتاجية نفسها التي تستخدمها حلقة QA.
- يثبت عبر seams أن inputProps المرسلة data-only (`{ spec }` كما parseها
  المخطط) والـ composition المختار هو FQMG-OHZ-Preview حصرًا.
- الصدق البيئي: غياب ffprobe أو Chrome Headless Shell = تخطٍّ **مع سبب
  مسجّل**، ومع `FQMG_REQUIRE_RENDER_PIPELINE=1` = فشل. محليًا (بيئة معزولة
  بلا متصفح): اختبار ffprobe نُفّذ فعليًا (حزمة compositor Remotion تحمل
  ffprobe n7.1 داخل node_modules) ورندر المتصفح تَخَطّى؛ في CI (ubuntu-24.04
  + إنترنت مفتوح): `FQMG_REQUIRE_RENDER_PIPELINE=1` يجعل الرندر الكامل
  ينفّذ فعلًا مع استدعاء ffprobe حقيقي.
