# fqmg-ohz — Prompt to Motion Graphics

AI-powered motion graphics generator built with **Remotion** + **Next.js**, with a data-only Motion
Specification pipeline and a provider-independent voice engine.

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![GitHub last commit](https://img.shields.io/github/last-commit/mamourgroupe-ctrl/fqmg-ohz)
![GitHub repo size](https://img.shields.io/github/repo-size/mamourgroupe-ctrl/fqmg-ohz)
![Node](https://img.shields.io/badge/node-%3E%3D20.9-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)

---

## نظرة سريعة بالعربية

المستودع الآن **تطبيق واحد**. كان فيه مشروعان: المشروع الأساسي في الجذر (واجهة المحادثة والمحرر
والمعاينة وتوليد كود Remotion)، ومشروع فرعي في `fqmg-ohz-next/` (معمارية Phase 1 ومحرك الصوت
Phase 2). تم دمج الفرعي داخل الأساسي ونُقلت وحداته إلى `src/ai`, `src/motion`, `src/render`,
`src/voice`, و`src/remotion/entry.tsx`, مع `tests/`, `scripts/`, `templates/`, و`docs/` في الجذر،
ثم حُذف مجلد `fqmg-ohz-next/`.

- الواجهة الأصلية لم تتغير: `/api/generate` ما زال لتوليد الكود، وواجهة المحادثة/المحرر كما هي.
- أُضيف المخطط المحلي data-only على `POST /api/plan` (كان `POST /api/generate` داخل الفرعي).
- أُضيفت واجهات الصوت: `GET /api/voice/providers`، `POST /api/voice/synthesize`،
  `GET /api/voice/audio/{uuid}`.
- تفاصيل واجهات الصوت وحدود النشر: [`docs/voice-api.md`](docs/voice-api.md).

---

## Features

- 🎬 Text-to-video generation from natural language prompts (AI SDK + OpenAI)
- 🧠 Data-only **Motion Specification** pipeline (Zod schemas, no `eval`, no generated code execution)
- 🔊 **Provider-independent voice engine**: Azure Speech, ElevenLabs, Google Cloud TTS, OpenAI TTS,
  evidence-ranked `auto` routing, bounded retries/fallbacks, local managed audio cache and project
  voice pins
- ☁️ AWS Lambda rendering via Remotion Lambda
- ⚡ Live preview in browser (Next.js + Turbopack)
- 🎨 Ready-made components: Typewriter / Chat / Metric Counters / Bar Chart

---

## Requirements

- Node.js >= 20.9
- npm >= 10
- Git

---

## Installation

```bash
git clone https://github.com/mamourgroupe-ctrl/fqmg-ohz.git
cd fqmg-ohz
npm ci
```

---

## Configuration

Copy the example file and fill in what you actually use:

```bash
cp .env.example .env.local
```

`.env.example` lists every supported variable with blank credentials and non-secret defaults:
`OPENAI_API_KEY`, the Remotion Lambda AWS keys, the Azure Speech / ElevenLabs / Google Cloud TTS
settings, and the local voice-cache options (`VOICE_CACHE_DIR`, `VOICE_CACHE_TTL_HOURS`,
`VOICE_CACHE_MAX_BYTES`, `VOICE_REQUEST_TIMEOUT_MS`, `VOICE_MAX_RETRIES`, `VOICE_MAX_FALLBACKS`,
`VOICE_PROVIDER_ORDER`, …).

> WARNING: Never commit `.env.local` — it is already ignored by `.gitignore`.
> A provider variable being present is not proof of a live connection, and no provider call is made
> automatically by the UI.

---

## Development

```bash
npm run dev
```

Open: http://localhost:3000

---

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Next.js dev server (bound to `0.0.0.0` for sandboxed previews) |
| `npm run build` | Production build |
| `npm start` | Production server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest suite (`tests/`) |
| `npm run lint` | ESLint (app, Remotion, motion/voice modules, tests, scripts) |
| `npm run remotion` | Remotion Studio for the original `DynamicComp` composition |
| `npm run studio` | Remotion Studio for the `FQMG-OHZ-Preview` specification composition |
| `npm run render` | Remotion CLI render (`src/remotion/index.ts`) |
| `npm run render:preview` | Render `FQMG-OHZ-Preview` from `templates/phase-one-preview.json` |
| `npm run bundle:remotion` | Compile-check bundle of `src/remotion/entry.tsx` |
| `npm run voice:live-check:plan` | Print exactly what a live Azure voice check would send (no network) |
| `npm run voice:live-check` | LIVE provider check — makes real, billable requests |
| `npm run deploy` | Deploy the Remotion Lambda function/site |

---

## HTTP surface

| Route | Purpose |
| --- | --- |
| `POST /api/generate` | Original prompt-to-code generation (AI SDK / OpenAI) |
| `POST /api/plan` | Local data-only planner → validated `MotionSpecification` (no external provider) |
| `GET /api/voice/providers` | Sanitized provider configuration/health and bounded voice inventory |
| `POST /api/voice/synthesize` | Voice synthesis; optionally attaches the audio to a Motion Specification |
| `GET /api/voice/audio/{uuid}` | Serves locally managed audio through an opaque reference |

Details, limits, and the deployment boundary: [`docs/voice-api.md`](docs/voice-api.md).

---

## Project Structure

```
fqmg-ohz/
├── src/app/                 # Next.js App Router (UI + /api/generate, /api/plan, /api/voice/*)
├── src/components/          # Chat, editor, player UI (original)
├── src/hooks/               # Conversation / generation state (original)
├── src/ai/                  # DirectorProvider + scene planner (Phase 1, local rules)
├── src/motion/              # Motion Specification Zod schemas
├── src/render/              # Aspect-ratio presets, RenderJob, Remotion adapter + composition
├── src/voice/               # Voice contracts, provider adapters, routing, cache, pins, API schemas
├── src/remotion/            # DynamicComp root (index.ts) and FQMG-OHZ-Preview entry (entry.tsx)
├── src/lambda/              # Remotion Lambda client helpers (original)
├── src/skills/, src/examples/
├── tests/                   # Vitest suites for motion, render, voice, API
├── scripts/                 # Manual voice live check
├── templates/               # phase-one-preview.json Motion Specification
├── docs/                    # Voice API, Phase 1 architecture, Phase 2 plan, verification record
├── styles/, public/, types/
├── .github/workflows/       # Manual render-smoke and voice-live-check workflows
├── remotion.config.ts
└── package.json
```

---

## Rendering

Local Remotion CLI:

```bash
npm run studio            # interactive studio for the specification composition
npm run render:preview    # renders renders/phase-one-preview.mp4
```

Cloud (Remotion Lambda):

```bash
npm run deploy
```

A successful render is only reported after a real `.mp4`/`.webm` file exists and passes the
`ffprobe` gate (container, one video stream, dimensions, frame rate, positive duration). Audio
tracks are still rejected by the Remotion adapter: audio mixing is not implemented, so audio-bearing
projects fail closed.

---

## Quality gates

```bash
npm test          # Vitest, tests/ (119 tests across 15 files at the time of the merge)
npm run typecheck
npm run lint
npm run build
```

---

## Documentation

- [`docs/voice-api.md`](docs/voice-api.md) — Voice/plan API surface, environment, storage, limits
- [`docs/phase-1-architecture.md`](docs/phase-1-architecture.md) — Phase 1 architecture boundaries
- [`docs/phase-2-plan.md`](docs/phase-2-plan.md) — Phase 2 compatibility audit and implementation
- [`docs/PHASE2_VERIFICATION.md`](docs/PHASE2_VERIFICATION.md) — dated verification record
- [`docs/current-architecture.md`](docs/current-architecture.md) — audit of the original project

> **Deployment boundary:** there is no user authentication, authorization, or distributed rate
> limiting yet. Do not expose `POST /api/voice/synthesize` publicly with provider credentials before
> those controls exist. The local voice cache and voice pins are single-instance filesystem state,
> not durable storage.

---

## License

MIT
