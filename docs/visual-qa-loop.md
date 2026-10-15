# Visual QA and bounded repair loop

> **ملخص عربي:** أُضيفت دورة «توليد ← عرض ← تحقّق تقني بـ ffprobe ← استخراج إطارات ← نقد بصري ←
> إصلاح محدود ← إعادة عرض» فوق المسارات الموجودة، دون نظام توليد ثانٍ ودون تنفيذ أي شيفرة مولّدة.
> كل المزوّدين مدفوعين ومغلقون افتراضيًا، والميزانية محصورة بـ 0.03 دولار للمهمة و0.25 دولار لليوم،
> ولا يُعاد المتصفح أبدًا كمسارات داخلية. الحالة `needs_review` تعني «معاينة وليست تسليمًا معتمدًا».

**Scope of this document:** the render-and-review job API (`/api/agent/qa/*`), its module layout,
the trust boundary, the budget controls, and exactly what has been verified versus what has not.
Everything below describes code in this repository; nothing here is a paid-provider claim.

## 1. Pipeline

```
MotionSpecification (data only, Zod-validated)
        │
        ▼
POST /api/agent/qa ──► AgentJobStore.startJob (in-process job, 202 + poll path)
        │                    │
        │                    ▼
        │            runAgentLoop (src/agent/loop.ts)
        │                    │
        │         ┌──────────┴───────────────────────────────────────────────┐
        │         │ 1. render      RenderBackend: remotion-local | remotion-lambda
        │         │ 2. materialize ArtifactSchema → local file path (download if remote)
        │         │ 3. validate    EXISTING ffprobe gate (verifyRenderOutput)
        │         │ 4. frames      extractRepresentativeFrames (bundled ffmpeg/ffprobe)
        │         │ 5. critique    budget-gated vision provider → Zod-validated verdict
        │         │ 6. repair      deterministic rules first, then (opt-in) AI proposal
        │         │ 7. repeat      bounded by maxIterations (default 2, hard max 4)
        │         └───────────────────────────────────────────────────────────────┘
        │
        ▼
GET  /api/agent/qa/{jobId}          validated public job view (polling)
DELETE /api/agent/qa/{jobId}        cancellation
GET  /api/agent/qa/{jobId}/preview  streams a retained local preview (opaque path, never a filesystem path)
```

The HTTP request is never held open for a render cycle: `POST` only acknowledges (202), and the
browser polls. This reuses the existing job/polling pattern (`src/helpers/use-rendering.ts`,
`/api/lambda/progress`) instead of adding a competing mechanism.

## 2. Module map

| File | Responsibility |
| --- | --- |
| `src/agent/motion-rules.ts` | The single MOTION_RULES policy: rule catalogue, prompt section for `/api/generate`, critique rubric, WCAG contrast maths. |
| `src/agent/config.ts` | `AgentConfig` schema + `AGENT_*` environment loading; malformed values fail closed at startup. |
| `src/agent/artifact.ts` | Explicit artifact contracts (`local-file` / `remote-url`), public projection, path containment, materialisation (download limits). |
| `src/agent/video-probe.ts` | ffprobe metadata + full actual frame-timestamp timeline (bounded, no shell interpolation). |
| `src/agent/frame-extractor.ts` | Representative frame extraction with the bundled ffmpeg, per-frame verification, byte caps, cleanup, cancellation. |
| `src/agent/image-inspection.ts` | Image magic bytes, real dimensions, MIME allow-list, per-image limits. |
| `src/agent/vision-critique.ts` | Critique contract, payload construction, response parsing/validation, timeout and cancellation semantics. |
| `src/agent/vision-providers.ts` | `disabled` provider (default) and an OpenAI-compatible adapter that requires an explicit capability confirmation. |
| `src/agent/pricing.ts` | Verified-price book, token estimation (`ceil(w*h/500)` for images), cost estimates that refuse to invent prices. |
| `src/agent/budget.ts` | Process-local ledger: reserve → settle/release, task and daily ceilings, approval handling. |
| `src/agent/redaction.ts` | Secret redaction and absolute-path shortening for every message that can leave the server. |
| `src/agent/local-repair-provider.ts` | Deterministic, data-only repairs (safe area, contrast, RTL, minimum size, readable beat). |
| `src/agent/repair-provider.ts` | Opt-in AI repair: untrusted proposal + integrity validation. |
| `src/agent/loop.ts` | The bounded loop itself: stages, statuses, retention rules, disclosures. |
| `src/agent/render-contract.ts` | `RenderBackend` interface and error codes shared by the two engines. |
| `src/render/remotion/local-render-backend.ts` | Local Remotion render through the existing `src/remotion/entry.tsx` composition. |
| `src/render/lambda/lambda-render-backend.ts` | Remotion Lambda render producing a remote HTTPS artifact. |
| `src/agent/job-store.ts` | In-process job registry: dedupe, capacity, TTL, cancellation, cleanup of retained artifacts, the only browser-facing job view. |
| `src/agent/runtime.ts` | Process-wide wiring; defaults are inert (no vision, no AI repair, empty price book). |
| `src/agent/api/request-schema.ts` | HTTP request/response/error schemas and the dedupe key. |
| `src/app/api/agent/qa/**` | The three route handlers. |

Nothing in the loop executes model-authored code, opens a shell, or reads a path chosen by a model
or a client. The render path is the existing trusted composition
(`src/render/remotion/MotionComposition.tsx`), which renders the data-only specification.

## 3. Statuses and what they mean

| Status | Meaning |
| --- | --- |
| `passed` | A render passed the ffprobe gate **and** a configured vision provider approved it (`verdict: "approve"`). Only here is `approved: true`. |
| `needs_review` | A technically valid render exists, but the visual verdict was `revise`, no verdict was obtainable, the budget refused the critique, or the iteration cap was reached. This is a **preview, not an approved deliverable**. |
| `failed` | No valid render was ever produced (render failed, or the first render failed the technical gate). |
| `cancelled` | The caller cancelled; the loop stops at the next stage boundary. |

A technical success is never reported as visual approval. At the iteration cap the loop returns
`needs_review` with `failureReason: "max-iterations"`. The last technically valid render is
retained (and its path disclosed in `disclosures`) when a later repair render fails, so a preview
survives a bad repair — but it is still not approved.

`disclosures[]` always carries the operator-facing caveats, including the process-local budget
limitation and the "previously validated render is retained" note.

## 4. Artifact contract

* A local Remotion render produces `{ kind: "local-file", absolutePath, ... }`.
* A Remotion Lambda render produces `{ kind: "remote-url", url (HTTPS), ... }`.
* Only `PublicArtifact` (`toPublicArtifact`) may reach a browser: it has **no** path field, and a
  local artifact is represented by the opaque route
  `/api/agent/qa/{jobId}/preview`, which re-checks the recorded path against the allowed roots
  before streaming it (`no-store`, `nosniff`, `Content-Disposition: inline`).
* Remote artifacts are never proxied: the polling view exposes the provider URL, and the preview
  route answers `409` for them.
* `assertPathWithinRoots` requires both a literal containment check and a `realpath` check, so a
  symlink inside an allowed root cannot escape it. Allowed roots default to
  `<cwd>/renders` and the OS temp directory.

## 5. Budget controls

| Control | Value |
| --- | --- |
| Task ceiling | `AGENT_TASK_BUDGET_USD`, default **0.03 USD** |
| Daily ceiling | `AGENT_DAILY_BUDGET_USD`, default **0.25 USD** (UTC day) |
| Pricing | Only operator-supplied, source-stamped prices are used; **unknown price ⇒ the paid call is refused** (`pricing-unknown`). |
| Reservation | `reserve → settle` (the request may have been dispatched) or `release` (it provably was not). |
| Per-task exception | `budgetApproval` = `{ kind: "user-approved-exception", approvedBy, maxUsd, reason }`; it can never raise the daily ceiling. |
| Enforcement | `enforcement: "process-local"`, `invoiceGuarantee: false`. Counters live in one process; they are not a distributed limiter and do not bound the provider's own invoice. There is still no authentication in front of these routes (see the README deployment boundary). |

`estimateCost` returns `undefined` when no verified price exists, and the loop treats that as a
refusal rather than a zero-cost request. Image token estimates are deliberately pessimistic
(`ceil(width*height/500)`, i.e. above the common `width*height/750` behaviour).

## 6. Trust boundary and security controls

* **No generated code execution.** The specification is data (`src/motion/schemas/motion-specification.ts`).
  A repair can only rewrite that data.
* **Deterministic first.** Five rules have deterministic repairs (`layout-safe-area`,
  `typography-contrast`, `typography-arabic-rtl`, `typography-minimum-size`, `timing-readable-beat`).
  A paid AI repair is only attempted when the local pass changed nothing and a repair provider is
  explicitly enabled.
* **AI repairs are untrusted.** `validateRepairCandidate` re-validates the proposal against the
  specification schema and refuses any change to project identity, canvas, frame rate, duration,
  scene ids/order, or assets (no new assets, no repointed sources).
* **Model output is untrusted data.** The critique is parsed as JSON and validated by Zod
  (`verdict`, `score`, bounded issue list, known rule ids or `other`, internal consistency such as
  "approve cannot carry a critical issue"). A malformed verdict becomes `critique-failed`, never an
  approval.
* **Images are validated before they are sent:** magic bytes, real dimensions, an allow-list of
  `image/jpeg`/`image/png`, per-image and total payload byte limits, and a maximum image count.
* **No assumption of image support.** A vision provider is only constructed when an operator sets
  `AGENT_VISION_ENABLED=1` **and** `AGENT_VISION_IMAGE_SUPPORT_VERIFIED=1` (an explicit statement
  that the chosen model's documentation confirms image input). Otherwise the provider stays
  `disabled` and the loop reports `needs_review`.
* **Processes only via `execFile`** with argument arrays, explicit timeouts, output byte caps, and
  no shell interpolation (ffprobe/ffmpeg). Only the bundled Remotion binaries are executed.
* **Nothing internal is returned.** Job views are validated before serialization; a view that fails
  validation is replaced by a redacted subset. Error messages pass through secret redaction and
  absolute-path shortening first.
* **Bounded work.** Iterations ≤ 4 (default 2), frames ≤ 8 (default 4), request bodies ≤ 128 KB,
  job capacity ≤ 32, job TTL (default 30 min) after which the retained preview is deleted.

## 7. Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_MAX_ITERATIONS` | `2` | Render→critique→repair cycles (1–4). |
| `AGENT_FRAME_COUNT` / `AGENT_FRAME_WIDTH` | `4` / `512` | Representative frames and their width (1–8, 128–1280). |
| `AGENT_*_TIMEOUT_MS` | see `src/agent/config.ts` | Render, probe, frame, critique, repair, artifact-download timeouts. |
| `AGENT_MAX_FRAME_BYTES` / `AGENT_MAX_TOTAL_FRAME_BYTES` / `AGENT_MAX_ARTIFACT_BYTES` | 2 MiB / 12 MiB / 64 MiB | Byte ceilings for frames and artifacts. |
| `AGENT_TASK_BUDGET_USD` / `AGENT_DAILY_BUDGET_USD` | `0.03` / `0.25` | Budget ceilings. |
| `AGENT_CRITIQUE_MAX_OUTPUT_TOKENS` / `AGENT_REPAIR_MAX_OUTPUT_TOKENS` | `600` / `16000` | Explicit provider output budgets. |
| `AGENT_VISION_ENABLED` | `0` | Enable the visual critique at all. |
| `AGENT_VISION_PROVIDER` / `AGENT_VISION_MODEL` / `AGENT_VISION_API_KEY` / `AGENT_VISION_BASE_URL` | empty | OpenAI-compatible vision endpoint. |
| `AGENT_VISION_IMAGE_SUPPORT_VERIFIED` | unset | Must be `1`: the operator states the model's docs confirm image input. |
| `AGENT_VISION_JSON_MODE` | `0` | Send `response_format: { type: "json_object" }` when the endpoint supports it. |
| `AGENT_REPAIR_ENABLED` / `AGENT_REPAIR_MODEL` | `0` / empty | Opt-in AI repair via the existing model router (credentials are still required). |
| `AGENT_PRICE_*` | empty | `AGENT_PRICE_INPUT_PER_MTOK`, `AGENT_PRICE_OUTPUT_PER_MTOK`, `AGENT_PRICE_SOURCE_URL`, `AGENT_PRICE_VERIFIED_ON`, `AGENT_PRICE_NOTES`. |
| `AGENT_KEEP_FRAMES` / `AGENT_JOB_TTL_MS` | `0` / `1800000` | Frame retention for debugging; job retention window. |
| `REMOTION_SERVE_URL` / `REMOTION_FUNCTION_NAME` / `REMOTION_REGION` | empty | Lambda render backend (plus the existing `REMOTION_AWS_*` credentials). |

With every `AGENT_*` variable unset the loop still runs, but it cannot reach a paid provider: the
critique is refused and the result is `needs_review`.

## 8. Verification status

Executed in this workspace (Node 22.22.3, no system ffmpeg/ffprobe, no Chrome):

| Check | Result |
| --- | --- |
| `npx vitest run` | **34 files / 359 tests passed** (baseline before this work: 22 files / 216 tests). |
| `npx tsc --noEmit` | exit 0. |
| `npx eslint .` | exit 0. |
| `npm run build` | exit 0 (requires the `serverExternalPackages` entry in `next.config.js`, see below). |
| Real frame extraction against generated media | Verified: bundled ffmpeg/ffprobe produce and sample real frames (17 tests, real-media suite included). Also available as a manual check: `npm run agent:frame-smoke`. |
| Real Remotion render | **Not possible here:** `npx remotion browser ensure` fails with `ECONNRESET` against `remotion.media`, and no Chrome/Chromium exists on the machine. |
| `npx remotion bundle src/remotion/entry.tsx` | exit 0 — the composition, entry point, and `@/*` alias override resolve. |
| Live vision/provider calls | **Never executed**; every provider test uses injected fakes. |

### Why `next.config.js` needs `serverExternalPackages`

The job API imports the render backends, which import `@remotion/bundler` and `@remotion/renderer`.
Those packages resolve optional, platform-specific native modules (`@remotion/compositor-*`,
`@remotion/whisper-webgpu`, `@remotion/video-matting`, esbuild's binary). Next's production build
fails while trying to bundle them, so they are declared as runtime externals:

```js
serverExternalPackages: ["@remotion/bundler", "@remotion/renderer", "@remotion/lambda", "esbuild"],
```

## 9. Limitations

* **No durable queue or worker.** Job state is in-process: a restart loses the registry and the
  retained previews, and two instances do not share jobs or budget counters.
* **No authentication, no distributed rate limiting.** These routes must not be exposed publicly
  as-is (see the README deployment boundary).
* **A local render requires a Remotion browser** (`npx remotion browser ensure`) that this sandbox
  cannot download; the local render path is therefore wired and unit-tested but never executed
  end-to-end here.
* **The bundled ffmpeg is a stripped build**: only `scale`/`zscale` filters and no hash muxers. The
  extractor therefore records which timestamp was requested, that a frame exists there, and the
  SHA-256 of the bytes that were reviewed — not a pixel-exact identity of the rendered frame.
* **Visual critique needs an operator-verified vision model.** This repository ships no verified
  price and no verified image support, so the loop returns `needs_review` until both are configured.
* **Audio, subtitles, and custom fonts are still refused by the renderer adapter**, so
  audio-bearing specifications cannot be rendered by either backend yet.
* **Lambda rendering is not verified** in this environment (no AWS credentials, no deployment).

## 10. Running it locally

```bash
# 1. Job API (no provider needed: the result will be needs_review)
curl -sS -X POST http://localhost:3000/api/agent/qa \
  -H 'content-type: application/json' \
  -d "$(jq -c '{specification: .}' templates/phase-one-preview.json)"

# 2. Poll
curl -sS http://localhost:3000/api/agent/qa/<jobId>

# 3. Cancel
curl -sS -X DELETE http://localhost:3000/api/agent/qa/<jobId>

# 4. Preview (only when the job produced a local render)
curl -sS -o preview.mp4 http://localhost:3000/api/agent/qa/<jobId>/preview
```

Tests for this subsystem, plus the manual real-media check:

```bash
npx vitest run tests/agent-*.test.ts
npm run agent:frame-smoke     # builds a clip with the bundled ffmpeg and extracts frames from it
```

Where a Remotion browser is available (`npx remotion browser ensure`), the local backend can be
driven end to end by the existing render script, which uses the same composition and alias
override:

```bash
npm run bundle:remotion        # compile-check the bundle (no browser needed)
npm run render:preview         # real local render of the preview composition
```
