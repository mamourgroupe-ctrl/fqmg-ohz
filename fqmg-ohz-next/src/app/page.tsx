"use client";

import { useState, type FormEvent } from "react";
import { ASPECT_RATIO_KEYS, ASPECT_RATIO_PRESETS, type AspectRatioPreset } from "@/render/presets/aspect-ratios";
import type { DirectorPlan } from "@/ai/director/plan-video";

const DEFAULT_PROMPT = "أنشئ إعلانًا قصيرًا وأنيقًا لمنتج محلي. ابدأ برسالة تجذب الانتباه، وضّح الفائدة، واختم بدعوة واضحة للتواصل. لا تخترع معلومات أو ادعاءات غير موجودة.";

const LANGUAGE_OPTIONS = [
  { value: "ar", label: "العربية" },
  { value: "fr", label: "Français" },
  { value: "en", label: "English" },
] as const;

const BEAT_LABELS: Record<string, string> = {
  hook: "الافتتاحية",
  problem: "التحدّي",
  solution: "الحلّ",
  benefits: "الفوائد",
  cta: "الدعوة إلى الإجراء",
  outro: "الخاتمة",
};

export default function HomePage() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [durationSeconds, setDurationSeconds] = useState(18);
  const [aspectRatio, setAspectRatio] = useState<AspectRatioPreset>("9:16");
  const [language, setLanguage] = useState<(typeof LANGUAGE_OPTIONS)[number]["value"]>("ar");
  const [dialect, setDialect] = useState("ar-DZ");
  const [voiceGender, setVoiceGender] = useState("unspecified");
  const [plan, setPlan] = useState<DirectorPlan | null>(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);
    setError("");
    setPlan(null);

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          durationSeconds,
          aspectRatio,
          language,
          ...(language === "ar" && dialect ? { dialect } : {}),
          voiceGender,
        }),
      });
      const data = (await response.json()) as DirectorPlan | { error?: string; issues?: Array<{ path: string; message: string }> };
      if (!response.ok) {
        const details = "issues" in data ? data.issues?.map((issue) => `${issue.path}: ${issue.message}`).join("\n") : "";
        throw new Error(["error" in data ? data.error : "تعذّر إنشاء الخطة.", details].filter(Boolean).join("\n"));
      }
      setPlan(data as DirectorPlan);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "حدث خطأ غير متوقع.");
    } finally {
      setIsLoading(false);
    }
  }

  async function copySpecification() {
    if (!plan) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(plan.motionSpecification, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      setError("تعذّر نسخ JSON إلى الحافظة في هذا المتصفح.");
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand-lockup" href="#top" aria-label="FQMG-OHZ NEXT home">
          <span className="brand-mark">F</span>
          <span>
            <strong>FQMG-OHZ <b>NEXT</b></strong>
            <small>AI CREATIVE VIDEO STUDIO</small>
          </span>
        </a>
        <div className="topbar-meta">
          <span className="status-dot" />
          <span>بيئة مستقلة · Phase 2</span>
          <span className="version-pill">0.1</span>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <span className="eyebrow"><span className="eyebrow-line" /> من الفكرة إلى مخطط جاهز للحركة</span>
          <h1>ابدأ بفكرة.<br /><em>حوّلها إلى مشاهد.</em></h1>
          <p>وجّه الفيديو، وزّع إيقاعه، وأنشئ Motion Specification موحّدًا — من دون تشغيل كود مولّد أو الاعتماد على خدمة خارجية.</p>
        </div>
        <div className="hero-orbit" aria-hidden="true">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="orbit-center"><span>FQ</span><i>✦</i></div>
          <span className="orbit-tag tag-top">PROMPT</span><span className="orbit-tag tag-bottom">MOTION SPEC</span>
        </div>
      </section>

      <div className="workflow-strip" aria-label="مسار إنشاء الفيديو">
        {["Prompt", "AI Director", "Scenes", "Motion Spec", "Remotion"].map((step, index) => (
          <div className="workflow-step" key={step}>
            <span className={index < 4 ? "step-index complete" : "step-index"}>{index < 4 ? "✓" : "05"}</span>
            <span>{step}</span>
            {index < 4 && <span className="step-connector" />}
          </div>
        ))}
      </div>

      <section className="workspace-grid">
        <form className="panel brief-panel" onSubmit={handleSubmit}>
          <div className="panel-heading">
            <div><span className="panel-kicker">01 / BRIEF</span><h2>ما الفيديو الذي تتخيّله؟</h2></div>
            <span className="icon-orb">✳</span>
          </div>
          <label className="field-label" htmlFor="prompt">وصف الفكرة</label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="صف الفكرة، المنتج، الجمهور، والنبرة المطلوبة…"
            maxLength={4_000}
            required
          />
          <div className="field-meta"><span>اكتب تعليمات واضحة — لا تضف أسرارًا أو بيانات اعتماد.</span><span>{prompt.length}/4000</span></div>

          <div className="form-divider" />
          <div className="controls-grid">
            <label className="control-field">
              <span className="field-label">المدّة</span>
              <span className="input-with-suffix"><input type="number" min={2} max={180} value={durationSeconds} onChange={(event) => setDurationSeconds(Number(event.target.value))} /><small>ثانية</small></span>
            </label>
            <label className="control-field">
              <span className="field-label">نسبة العرض</span>
              <select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as AspectRatioPreset)}>
                {ASPECT_RATIO_KEYS.map((ratio) => <option value={ratio} key={ratio}>{ratio} · {ASPECT_RATIO_PRESETS[ratio].width}×{ASPECT_RATIO_PRESETS[ratio].height}</option>)}
              </select>
            </label>
            <label className="control-field">
              <span className="field-label">اللغة</span>
              <select value={language} onChange={(event) => setLanguage(event.target.value as (typeof LANGUAGE_OPTIONS)[number]["value"])}>
                {LANGUAGE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="control-field">
              <span className="field-label">الصوت المطلوب</span>
              <select value={voiceGender} onChange={(event) => setVoiceGender(event.target.value)}>
                <option value="unspecified">غير محدّد</option><option value="masculine">رجالي</option><option value="feminine">نسائي</option>
              </select>
            </label>
          </div>
          {language === "ar" && (
            <label className="control-field dialect-field">
              <span className="field-label">اللهجة / locale <small>اختياري</small></span>
              <input value={dialect} onChange={(event) => setDialect(event.target.value)} placeholder="مثال: ar-DZ" maxLength={80} />
              <span className="helper-text">يُحفظ الاختيار في الخطة فقط؛ توليد الصوت متاح عبر واجهة Phase 2 المنفصلة بعد إعداد موفّر.</span>
            </label>
          )}
          <div className="safety-note"><span>⌑</span><p>هذا النموذج ينشئ خطة محلية فقط؛ لا يطلب صوتًا أو ينزّل أصولًا أو يرسل بيانات إلى مزوّد خارجي.</p></div>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <button className="primary-button" type="submit" disabled={isLoading || prompt.trim().length < 3}>
            {isLoading ? <><span className="spinner" /> جارٍ بناء المخطط…</> : <>أنشئ مخطط الفيديو <span>←</span></>}
          </button>
          <div className="provider-footnote"><span className="provider-dot" /> Director: local-rules <i>·</i> بدون API key</div>
        </form>

        <section className="panel result-panel" aria-live="polite">
          {!plan && !isLoading && (
            <div className="empty-state">
              <div className="empty-icon"><span>✧</span><span>▱</span><span>✦</span></div>
              <span className="panel-kicker">02 / DIRECTION</span>
              <h2>مساحة الإخراج</h2>
              <p>بعد إنشاء الخطة ستظهر هنا نبذة الإخراج، توقيت المشاهد، وأبعاد التركيب.</p>
              <div className="empty-line"><span /> <span /> <span /></div>
            </div>
          )}
          {isLoading && <div className="loading-state"><span className="spinner large" /><span>ترتيب الإيقاع والمشاهد…</span><small>يتم التحقق من المخطط قبل عرضه</small></div>}
          {plan && (
            <div className="plan-content">
              <div className="panel-heading result-heading">
                <div><span className="panel-kicker">02 / DIRECTOR PLAN</span><h2>{plan.motionSpecification.project.title}</h2></div>
                <span className="plan-status">مخطط متحقق ✓</span>
              </div>
              <div className="summary-chips">
                <span><i>◷</i>{plan.plan.durationSeconds} ثانية</span>
                <span><i>▧</i>{plan.plan.aspectRatio}</span>
                <span><i>◎</i>{plan.plan.language.toUpperCase()}{plan.plan.dialect ? ` · ${plan.plan.dialect}` : ""}</span>
              </div>
              <div className="plan-brief">
                <div><small>النوع</small><strong>{plan.plan.videoKind}</strong></div>
                <div><small>الأسلوب البصري</small><strong>{plan.plan.visualStyle}</strong></div>
                <div><small>الجمهور</small><strong>{plan.plan.targetAudience}</strong></div>
              </div>
              <div className="scene-title-row"><div><span className="panel-kicker">SCENE PLAN</span><h3>إيقاع المشاهد</h3></div><span className="scene-count">{plan.plan.scenes.length} مشاهد</span></div>
              <div className="scene-timeline" aria-label="المخطط الزمني للمشاهد">
                {plan.plan.scenes.map((scene, index) => <span key={scene.id} className={`timeline-segment segment-${index + 1}`} title={`${scene.title} · ${scene.durationSeconds}s`} />)}
              </div>
              <div className="scene-list">
                {plan.plan.scenes.map((scene, index) => (
                  <article className="scene-card" key={scene.id}>
                    <span className="scene-number">{String(index + 1).padStart(2, "0")}</span>
                    <div className="scene-details"><div><strong>{BEAT_LABELS[scene.beat] ?? scene.title}</strong><span>{scene.title}</span></div><small>{scene.startSeconds.toFixed(1)}s — {(scene.startSeconds + scene.durationSeconds).toFixed(1)}s</small></div>
                    <span className="scene-duration">{scene.durationSeconds.toFixed(1)}s</span>
                  </article>
                ))}
              </div>
              <div className="render-target"><div className="render-icon">▣</div><div><small>مواصفات التركيب</small><strong>{plan.plan.render.width} × {plan.plan.render.height} <span>·</span> {plan.plan.render.fps} FPS</strong></div><span className="not-rendered">لم يُعرض</span></div>
              <div className="audio-note"><span>♪</span><p>الصوت: <b>{plan.plan.voice.gender === "masculine" ? "رجالي مطلوب" : plan.plan.voice.gender === "feminine" ? "نسائي مطلوب" : "غير محدّد"}</b> · لم يُولّد. {plan.plan.music.licensingNote}</p></div>
              <div className="json-header"><div><span className="panel-kicker">UNIVERSAL MOTION SPEC</span><strong>بيانات قابلة للنقل بين المحركات</strong></div><button type="button" onClick={copySpecification}>{copied ? "نُسخ ✓" : "نسخ JSON"}</button></div>
              <pre className="spec-json" dir="ltr"><code>{JSON.stringify(plan.motionSpecification, null, 2)}</code></pre>
              <p className="result-disclaimer">هذه واجهة التخطيط فقط؛ لم يُنشأ صوت أو أصل أو فيديو هنا. يمكن لواجهة Phase 2 المنفصلة إرفاق مرجع صوت بالمواصفة، لكن معاينة Remotion لا تمزج الصوت بعد.</p>
            </div>
          )}
        </section>
      </section>

      <footer className="footer"><span>FQMG-OHZ NEXT <i>·</i> isolated development</span><span>Core Architecture <i>→</i> Voice <i>→</i> Visual Intelligence <i>→</i> Render</span></footer>
    </main>
  );
}
