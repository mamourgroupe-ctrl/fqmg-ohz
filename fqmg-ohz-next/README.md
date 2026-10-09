# FQMG-OHZ NEXT — Phase 2 foundation

نسخة تطوير مستقلة داخل هذا المجلد. لا تعتمد أثناء التشغيل أو البناء على ملفات المشروع الأم أو حزم npm الخاصة به.

> **النطاق:** تدقيق Phase 0، معمارية Phase 1، وتنفيذ backend لصوت Phase 2. بقيت واجهة التخطيط والمعاينة محافظة على سلوك Phase 1 المحلي؛ لا تستدعي مزود صوت تلقائيًا. توجد واجهات API للصوت وعقود مشروع اختيارية، لكن لا توجد قاعدة بيانات أو مصادقة أو طابور عرض دائم. Phase 3 وAdobe وPinterest والاشتراكات والفوترة خارج النطاق.

## المتطلبات والتشغيل

- Node.js 20.9 أو أحدث.
- npm 10 أو أحدث.
- `npm ci` لتثبيت الاعتماديات.

```bash
npm ci
npm run dev
```

افتح العنوان الذي يطبعه Next.js. نموذج التخطيط يستدعي `POST /api/generate` محليًا، ولا يرسل طلب الخطة إلى مزود خارجي.

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

ابدأ من `.env.example` داخل هذا المجلد فقط. يضم متغيرات مفاتيح Azure وElevenLabs وOpenAI، وإعداد Google ADC/الاعتمادات، والمهلة/إعادة المحاولة/ترتيب الموفرين وذاكرة الصوت المؤقتة. القيم فارغة/افتراضية ولا تحتوي أسرارًا.

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

يوجد تركيب Remotion مستقل في `src/remotion/entry.tsx`. يمكن تشغيل `npm run bundle:remotion` أو `npm run studio`. يسمح مخطط المشروع ببيانات الصوت الاختيارية، لكن `RemotionAdapter` يرفض أي مشروع يحوي مسارات صوت حتى يضاف ويمر اختبار المزج؛ لذلك لا يدّعي preview احتواء الصوت.

أمر `npm run render:preview` يحتاج Chrome Headless Shell/Chrome متوافقًا. Remotion يحاول تنزيل Chrome Headless Shell عند عدم وجوده. كما أن التحقق النهائي الحالي يستدعي `ffprobe` على `PATH` ويظل fail-closed. لا يُعد أي رندر ناجحًا إلا بعد وجود ملف حقيقي واجتيازه التحقق من الحاوية والمدة والأبعاد ومعدل الإطارات.

راجع `docs/phase-2-plan.md` لتفاصيل حدود التوافق والنتائج المتحققة، و`docs/current-architecture.md` لتقرير تدقيق المشروع الأصلي، و`docs/phase-1-architecture.md` لمعمارية الأساس.
