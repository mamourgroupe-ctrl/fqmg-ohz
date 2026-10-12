# واجهات الفيديو والصوت بعد الدمج

هذا الملف هو نسخة محدثة من `README.md` الخاص بالمشروع الفرعي `fqmg-ohz-next/` بعد نقله إلى جذر المستودع. المشروعان أصبحا تطبيق Next واحدًا: واجهة التوليد والمحرر الأصلية لم تتغير، وأُضيفت إليها مسارات التخطيط والصوت مستقلة.

> **النطاق:** معمارية Phase 1 وتنفيذ backend للصوت في Phase 2. لا توجد قاعدة بيانات، ولا مصادقة، ولا طابور عرض دائم، ولا مزج صوت داخل الرندر. Phase 3 وAdobe وPinterest والاشتراكات والفوترة خارج النطاق.

## المسارات

| المسار | الوصف |
| --- | --- |
| `POST /api/generate` | مسار المشروع الأصلي: توليد كود Remotion بواسطة AI SDK/OpenAI (لم يتغير). |
| `POST /api/plan` | المخطط المحلي data-only: يحوّل وصف الفيديو إلى `MotionSpecification` صالحة، بلا مزود خارجي. كان هذا المسار سابقًا `POST /api/generate` داخل المشروع الفرعي، ونُقل إلى `/api/plan` بعد الدمج لأن `/api/generate` محجوز للواجهة الأصلية. |
| `GET /api/voice/providers` | فحص حالة الموفرين والأصوات. |
| `POST /api/voice/synthesize` | توليد الصوت، وإرفاقه بالمواصفة اختياريًا. |
| `GET /api/voice/audio/{uuid}` | قراءة الصوت المُدار محليًا عبر مرجع UUID مبهم. |

## مخطط الفيديو (Phase 1)

```http
POST /api/plan
Content-Type: application/json
```

الطلب والاستجابة يعبران عبر عقد Zod (`DirectorRequestSchema`) ولا يُنفَّذ أي كود مولّد: المواصفة بيانات فقط، ويستهلكها `RemotionAdapter` و`MotionComposition`. الحد 32 KB للجسم، والأخطاء آمنة ولا تكشف تفاصيل داخلية.

## Voice API (Phase 2)

### فحص الموفرين والأصوات

```http
GET /api/voice/providers?languageTag=ar-DZ&includeVoices=1
```

`languageTag` اختياري ويكون افتراضيًا `ar-DZ`. تتضمن الاستجابة حالة الإعداد، حالة نجاح/فشل جلب inventory، مؤشرات نجاح/زمن حديثة داخل العملية، أسماء متغيرات البيئة المطلوبة (من دون قيمها)، وما إذا وجدت inventory حالية دليلًا موثقًا على `ar-DZ`. إذا تعذر فحص موفر، تظهر الحالة `inventory-incomplete` بدل الادعاء بعدم وجود صوت. يقتصر عرض الأصوات على 100 صوت لكل موفر؛ وعند الاقتطاع يعاد اسم الموفر في `truncatedProviders`. لا تعني نتيجة “غير مهيأ” أو “لم يُعثر” أن الموفر لا يدعم اللغة عالميًا.

### التوليد

```http
POST /api/voice/synthesize
Content-Type: application/json
```

```json
{
  "synthesis": {
    "projectId": "example-project",
    "text": "A short narration.",
    "languageTag": "en-US",
    "provider": "auto",
    "speakingRate": 1,
    "outputFormat": "mp3"
  }
}
```

لإرفاق الصوت بالمواصفة، أرسل أيضًا `motionSpecification` كاملة و`placement`:

```json
{
  "synthesis": {
    "projectId": "example-project",
    "text": "A short narration.",
    "languageTag": "en-US",
    "provider": "auto"
  },
  "motionSpecification": { "...": "complete validated Motion Specification" },
  "placement": {
    "startFrame": 0,
    "durationInFrames": 90,
    "gain": 1,
    "allowVoiceChange": false
  }
}
```

الإجابة تعيد `result` يتضمن الموفر والصوت المختارين والإفصاحات و`audio.href` مبهمًا مثل `/api/voice/audio/{uuid}`. عند إرسال المواصفة يعاد أيضًا `motionSpecification` محدثًا بأصل صوت ومسار صوت وبيانات اختيار الصوت؛ على المستدعي حفظ المواصفة بنفسه. اطلب `allowVoiceChange: true` لتغيير صوت المشروع صراحةً. تغيير تلقائي بسبب تعذر الصوت المثبّت يعاد مع إفصاح fallback.

الصوت يُقرأ فقط من:

```http
GET /api/voice/audio/{uuid}
```

المسار يقبل UUID، ثم يحل مرجعًا محليًا مُدارًا ويتحقق من hash/الحجم؛ لا تُكشف مسارات نظام الملفات. لا تستخدم مصدرًا خارجيًا أو مسارًا محليًا داخل مواصفة الصوت.

### المطابقة وحدود الإثبات

- المعرّفات: `azure-speech`, `elevenlabs`, `google-cloud`, `openai`، أو `auto`.
- `AUTO` يرتّب الأصوات وفق evidence من inventory، ويضع حدًا للمحاولات والـfallback والمهلة. يتم تعقيم رسائل الخطأ.
- طلب `ar-DZ` يفشل مغلقًا إذا لم يوجد دليل inventory دقيق/موثّق. يمكن السماح بمطابقة لغوية تقريبية عبر `allowUnverifiedDialect: true`، ويعاد إفصاح بأن اللهجة غير متحققة. اختيار صوت صريح بلا دليل لهجة يعاد مع إفصاح غير موثق.
- توثيق دعم العربية عمومًا لا يثبت دعم اللهجة الجزائرية. وجود adapter أو مفاتيح بيئة لا يثبت اتصالًا مباشرًا أو جودة صوت.
- اختبارات الموفرين تستخدم fixtures؛ لم تُختبر حسابات حية في هذه البيئة.

### إعداد البيئة والتخزين

ابدأ من `.env.example` في جذر المستودع. يضم متغيرات مفاتيح Azure وElevenLabs وOpenAI، وإعداد Google ADC/الاعتمادات، والمهلة/إعادة المحاولة/ترتيب الموفرين وذاكرة الصوت المؤقتة، إضافة إلى مفاتيح المشروع الأصلي (`OPENAI_API_KEY` وRemotion Lambda). القيم فارغة/افتراضية ولا تحتوي أسرارًا.

تُخزن الملفات وملفات تثبيت الصوت محليًا في `.voice-cache/` افتراضيًا (مستثنى من Git)، أو في `VOICE_CACHE_DIR`. مهلة cache تتحكم في إعادة الاستخدام؛ `VOICE_CACHE_ENABLED=false` يعطّل إعادة استخدام الهوية لكنه لا يمنع تخزين الصوت اللازم للمرجع المُدار. حد الحجم يمنع الكتابة فوق السعة ولا ينفذ تنظيفًا تلقائيًا للأصوات/المراجع المنتهية. التخزين محلي لنسخة واحدة، غير مشترك بين نسخ متعددة، ولا يُعد قاعدة بيانات أو تخزينًا دائمًا لخدمة serverless. استخدم مجلدًا writable ومستمرًا في النشر، ولا تعرضه كمسار HTTP.

**حد النشر:** لا يحتوي التطبيق بعد على مصادقة مستخدم أو تفويض أو rate limiting موزّع. لا تنشر `POST /api/voice/synthesize` على إنترنت عام مع مفاتيح مزودين قبل إضافة هذه الضوابط؛ حدود الجسم/النص/الصوت والمهلة لا تحل محل المصادقة.

## الفحوصات

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## Remotion والرندر

يوجد تركيبان مستقلان تحت `src/remotion/`:

- `src/remotion/index.ts` — تركيب `DynamicComp` الأصلي (الكود المولّد)، ويُستخدم في `npm run remotion` و`npm run render` وفي نشر Lambda.
- `src/remotion/entry.tsx` — تركيب `FQMG-OHZ-Preview` القائم على مواصفة البيانات، ويُستخدم في `npm run studio` و`npm run bundle:remotion` و`npm run render:preview`.

يسمح مخطط المشروع ببيانات الصوت الاختيارية، لكن `RemotionAdapter` يرفض أي مشروع يحوي مسارات صوت حتى يضاف ويمر اختبار المزج؛ لذلك لا يدّعي preview احتواء الصوت.

أمر `npm run render:preview` يحتاج Chrome Headless Shell/Chrome متوافقًا. Remotion يحاول تنزيل Chrome Headless Shell عند عدم وجوده. كما أن التحقق النهائي الحالي يستدعي ffprobe (نسخة Remotion المضمّنة أولًا ثم `PATH`) ويظل fail-closed. لا يُعد أي رندر ناجحًا إلا بعد وجود ملف حقيقي واجتيازه التحقق من الحاوية والمدة والأبعاد ومعدل الإطارات.

راجع `docs/phase-2-plan.md` لتفاصيل حدود التوافق والنتائج المتحققة، و`docs/current-architecture.md` لتقرير تدقيق المشروع الأصلي، و`docs/phase-1-architecture.md` لمعمارية الأساس، و`docs/PHASE2_VERIFICATION.md` لسجل التحقق التفصيلي.
