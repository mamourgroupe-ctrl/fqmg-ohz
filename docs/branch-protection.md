# حماية فرع `main` — الإعداد المطلوب (المرحلة 0)

> **الحالة:** موثّق فقط، غير مُطبَّق. التطبيق يتطلب صلاحية admin على المستودع وهو قرار
> صاحب المشروع (انظر `docs/decisions.md` D-005). ينطبق الإعداد على فرع `main` فقط.

## لماذا

سيرتا `.github/workflows/` القديمان يعملان يدويًا فقط، والآن أضاف `ci.yml` بوابات تلقائية
على كل push وpull request. بدون حماية الفرع يمكن الدمج مباشرة في `main` متجاوزًا البوابات،
فيفقد خط الأساس (اختبارات 365+، typecheck، lint، build) معناه.

## الخطوات (GitHub ← واجهة الويب)

1. **Settings ← Branches ← Add branch ruleset** (أو «Branch protection rules» في النمط القديم).
2. **Rule name:** `main-requires-ci` — **Enforcement status:** Active.
3. **Target branches:** `main`.
4. فعّل:
   - ✅ **Require a pull request before merging** — Required approvals: `1`
     (يرفع "⚠️ المراحل 3 و4 تحتاجان مراجعة بشرية" في `CLAUDE.md` من توصية إلى إلزام آلي).
   - ✅ **Require status checks to pass before merging** — Search and add the check: **`gates`**
     (هذا اسم فحص `ci.yml` بعد أول تشغيل ناجح على `main`؛ إن لم يظهر الاسم بعد، شغّل أي
     push على `main` أو افتح PR مرة واحدة ليعرف GitHub اسم الفحص).
   - ✅ **Require branches to be up to date before merging** — يمنع دمج PR قديم تجاوز فحوص حديثة.
   - ✅ **Require conversation resolution before merging** (اختياري لكن مستحسن).
   - ✅ **Do not allow bypassing the above settings** — يشمل المدراء؛ إن أردت مخرج طوارئ
     فاتركه معطلًا مع الالتزام الذاتي.
5. **Save changes**.

## البديل عبر `gh` (للمالك، من جهازه)

```bash
# يفترض توفر صلاحية admin — لا يُشغَّل من جلسة الوكيل (docs/decisions.md D-005)
gh api -X PUT repos/mamourgroupe-ctrl/fqmg-ohz/branches/main/protection \
  -f required_status_checks.strict=true \
  -f required_status_checks.contexts[]="gates" \
  -F enforce_admins=true \
  -F required_pull_request_reviews.required_approving_review_count=1 \
  -F restrictions=null \
  -F allow_force_pushes=false -F allow_deletions=false
```

## معيار التحقق بعد التطبيق

- محاولة دمج PR بفحص `gates` أحمر تفشل في واجهة GitHub.
- الدفع المباشر إلى `main` يُرفض (`remote: error: GH006 ...`).

## التنبيهات

- `npm audit --omit=dev` داخل فحص `gates` بوضع تحذيري حتى المرحلة 1 (`docs/decisions.md`
  D-002)؛ لا يعني النجاح الأخضر اليوم خلو تبعيات الإنتاج من ثغرات معلومة.
- الرفع اليدوي (`push -f`) إلى فروع أخرى غير ممنوع بهذا الإعداد؛ الحماية لـ `main` فقط.
