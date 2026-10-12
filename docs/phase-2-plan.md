# Phase 2 — Universal Voice Engine: audit, compatibility, implementation, and verification

> **Merge note (2026-10-12):** the `fqmg-ohz-next/` sub-project described here was merged into the
> repository root. Paths written as `fqmg-ohz-next/<...>` now live at `<...>` from the root, the
> composition id `FQMG-OHZ-NEXT-Preview` is now `FQMG-OHZ-Preview`, and the data-only plan route is
> now `POST /api/plan` (the sub-project's old `POST /api/generate` path is occupied by the original
> prompt-to-code route). No result or claim below was changed.

**Scope:** Phase 2 only, inside `fqmg-ohz-next/` (now the repository root). Phase 0/1 foundations remain in place. Phase 3, Adobe, Pinterest, subscriptions, and billing are out of scope.

## 1. Compatibility audit

- The isolated app uses Next.js App Router, TypeScript, Zod 4, and Remotion 4. The voice endpoints run in Node.js because provider adapters, project pins, and managed audio use local filesystem APIs. Supported Node version remains `>=20.9`.
- The planner still returns the existing data-only `MotionSpecification`; old Phase 1 JSON remains valid. The audio model now accepts optional provider-independent voice-selection metadata at the audio-spec and individual-track levels.
- The existing `RemotionAdapter` intentionally rejects all non-empty audio tracks. The new attachment helper does not weaken that gate: audio can be preserved in the project specification, but is not mixed into the preview or render.
- Render completion still requires a real `.mp4`/`.webm` file and a successful `ffprobe` report with a video stream, dimensions, frame rate, and positive duration. No change marks a job successful without that check.
- Provider adapters are fixtures-tested, not live-account-tested. Documentation or a blank environment variable is not treated as a live provider connection, a voice inventory result, or proof of audio quality.
- No project database, object storage, user authentication, distributed rate limiter, render worker, or durable project service exists in this isolated foundation. Provider pins and managed audio are local filesystem state only.

## 2. Provider evidence and dialect constraints

| Provider | Adapter behavior | Evidence/compatibility boundary |
| --- | --- | --- |
| Azure Speech | Resource/region-aware voice listing and MP3 synthesis; endpoint host/path and locale records are validated. | The configured resource inventory is the source of voice/locale evidence. A generic language-support page is not proof that the account has a TTS voice for `ar-DZ`. |
| ElevenLabs | Authenticated account voice pagination and MP3 synthesis; language/locale evidence is mapped from `verified_languages`. | Account inventory is bounded and paginated. Generic Arabic or an accent label alone does not prove Algerian dialect support. |
| Google Cloud TTS | Voice listing by requested language, ADC/OAuth, and MP3 synthesis. The returned voice locale is used for the synthesis request. | The returned BCP-47 voice locale is checked; a provider substitution is not silently labeled as an exact match. No dialect/style inventory is inferred from a generic language code. |
| OpenAI TTS | Isolated speech endpoint adapter with documented language/voice profiles and validated MP3 output. | Arabic as an input language does not establish Algerian-Arabic quality. The adapter exposes no `ar-DZ` locale/dialect evidence. Voice-option documentation has inconsistent introductory counts; this plan intentionally makes no count or Algerian-support claim. |

**Routing rule:** Exact locale or specific verified-dialect evidence outranks generic language evidence. Strict `ar-DZ` AUTO matching fails closed when the live/configured inventory has no Algerian evidence. `allowUnverifiedDialect` is an explicit opt-in for approximate AUTO matching and is disclosed; an explicitly selected voice with unknown dialect evidence is also disclosed as unverified.

Official references reviewed during the audit:

- [Azure text-to-speech REST API](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech) and [Azure language/voice support](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts)
- [ElevenLabs list voices](https://elevenlabs.io/docs/api-reference/voices/search), [get voice](https://elevenlabs.io/docs/api-reference/voices/get), and [text-to-speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)
- [Google supported voices and languages](https://docs.cloud.google.com/text-to-speech/docs/list-voices-and-types), [voices:list](https://docs.cloud.google.com/text-to-speech/docs/reference/rest/v1/voices/list), and [text:synthesize](https://docs.cloud.google.com/text-to-speech/docs/reference/rest/v1/text/synthesize)
- [OpenAI text-to-speech guide](https://developers.openai.com/api/docs/guides/text-to-speech) and [speech API reference](https://developers.openai.com/api/docs/api-reference/audio/createSpeech)

**Live-account result:** no provider synthesis or authenticated account inventory was tested in this verification. No Algerian-Arabic voice has been verified for this application. Fixture data in unit tests is not an actual provider result.

## 3. Implemented interfaces and model behavior

### HTTP surface

- `GET /api/voice/providers?languageTag=ar-DZ&includeVoices=1` returns sanitized provider configuration/health summaries and, optionally, a bounded voice-profile list. The default query locale is `ar-DZ`. The result distinguishes a current inventory match from providers that are not configured; it is not a global capability guarantee.
- `POST /api/voice/synthesize` accepts a Zod-validated `{ synthesis, motionSpecification?, placement? }` JSON envelope. Bodies are streamed with a 1 MiB limit, require JSON content type, and the synthesis contract bounds normalized text/options. Errors are safe and do not include provider bodies, keys, or filesystem paths.
- If both a motion specification and placement are included, the response contains the validated synthesis result and an updated specification with a generated-audio asset, voice track, managed reference, and selected-voice metadata. The caller is responsible for persisting that returned specification; no project database is implied.
- `GET /api/voice/audio/{uuid}` resolves only locally created UUID reference records and verifies the content-addressed audio object before returning MP3 bytes. Public metadata contains an opaque route reference only, never the local cache path.

### Router, pins, and cache

- Provider IDs are `azure-speech`, `elevenlabs`, `google-cloud`, and `openai`; AUTO ranks bounded provider candidates with recent in-memory success/latency/health data.
- Retries are bounded and limited to transient provider errors; per-request timeouts and maximum fallback count are configurable. Provider change and unverified capability are disclosed.
- A project-level voice pin is written atomically to the configured local data directory. Requests that carry a project specification seed/check its pin within the same per-project serialization boundary; pin conflicts fail with a safe `409` response. Explicit voice changes require confirmation in the project attachment request. Local pin state is not distributed across server instances.
- The cache key covers version, provider/model/voice, normalized text, requested and synthesis language tags, dialect, style, rate, and output format. Cache manifests contain hashes and metadata, not spoken text. Content-addressed MP3 objects are hash/size/MP3 validated; UUID references resolve through a narrow managed route.
- `VOICE_CACHE_TTL_HOURS` controls reuse, `VOICE_CACHE_MAX_BYTES` bounds stored audio, and `VOICE_CACHE_DIR` chooses the local directory. TTL expiry prevents cache reuse but does not delete existing references/objects; no automatic garbage collector is implemented. The default `.voice-cache/` is Git-ignored.

### Motion/preview compatibility

- `AudioSpecSchema.voiceSelection` and `AudioTrackSchema.voiceSelection` are optional. Old preview specifications parse without changes.
- A managed `/api/voice/audio/{uuid}` source is accepted only for a strict UUID route. Provider errors and cache paths are not accepted as audio sources.
- `applyVoiceResultToMotionSpecification` validates project ID, reference, timing, fades, and explicit voice-change policy. It does not claim duration measurement from the generated file; the caller supplies `startFrame` and `durationInFrames`.
- Remotion continues to reject a non-empty audio track with a clear reason. This is expected fail-closed behavior, not a successful audio render.

## 4. Configuration and deployment compatibility constraints

Only `fqmg-ohz-next/.env.example` is updated for environment configuration; it contains blank credential placeholders and non-secret defaults. Supported variables include provider credentials/endpoints, Google ADC/project setup, provider ordering, inventory TTL, request timeout, retry/fallback bounds, and local cache settings.

- Azure Speech needs a key plus supported region or resource endpoint. Endpoint host/path validation is intentionally restrictive.
- ElevenLabs needs an account API key; voice inventory is account-specific and bounded by the adapter pagination ceiling.
- Google uses `GOOGLE_APPLICATION_CREDENTIALS` or Application Default Credentials; local credential-file paths must not be copied into source control. `GOOGLE_CLOUD_PROJECT` is optional/recommended for the configured environment.
- OpenAI needs an API key; `OPENAI_BASE_URL` is HTTPS-only in production (local HTTP is restricted to local development), and `OPENAI_TTS_MODEL` controls the documented model selection.
- Cache and pin files need a writable local directory. A persistent volume is required if references/pins must survive restarts; multiple server instances need shared, concurrency-safe storage not implemented here. Serverless ephemeral disks are not a durable store.
- There is no application authentication/authorization or distributed rate limit yet. Do not expose the synthesis endpoint publicly with provider credentials until those controls are added. This is an explicit deployment blocker, not a Phase 2 success claim.
- The API body/text/time/audio/storage limits reduce resource abuse but do not substitute for authorization or account-level cost controls.

## 5. MP4 prerequisite investigation and observed outcome

- `npm run render:preview` attempted to fetch Remotion's Chrome Headless Shell because no compatible browser was installed or cached. The download failed with `ECONNRESET` while contacting `remotion.media`; no Remotion composition render was produced.
- This environment has no system `ffmpeg`, `ffprobe`, Chromium, Chromium Browser, or Google Chrome command on `PATH`. Remotion's Linux x64 compositor package does include bundled FFmpeg and FFprobe 7.1.
- `verifyRenderOutput` now resolves Remotion's bundled FFprobe first, then falls back to `ffprobe` on `PATH`. Its success gate still requires a real MP4/WebM file plus a valid ffprobe video stream, dimensions, frame rate, and duration.
- A one-second synthetic black H.264 MP4 was generated with the bundled FFmpeg and validated with the bundled FFprobe: 1,846 bytes, 160×90, 24 fps, 1.0 second. This validates the media binaries and completion gate only; it is **not** a Remotion project render.
- **Actual project-render result:** blocked on the missing Chrome Headless Shell. No project render is marked successful. Audio-bearing projects remain fail-closed until actual audio mixing is implemented and tested.
- **Follow-up (2026-10-09):** the `remotion browser ensure` retry failed again with `ECONNRESET` from `remotion.media`. No system browser is installed, and the apt mirror is unreachable. A Remotion bundle compile check passed; a bundle is not a render. A manual-only workflow was added at `fqmg-ohz-next/.github/workflows/render-smoke.yml`. It is inert until moved to the repository root and has not been run.
- See [`docs/PHASE2_VERIFICATION.md`](PHASE2_VERIFICATION.md) for the detailed integration findings, official-provider documentation cross-check, and user actions.

## 6. Verification record

Fixture/unit coverage includes request/contract validation, all four isolated provider adapters, malformed/provider failure handling, locale/dialect evidence and AUTO failure/fallback, pin persistence/concurrency/conflicts, cache identity/TTL/size/concurrency/tamper cases, safe audio references, API envelope/body limits, project-model attachment, preview compatibility, and fail-closed render validation.

- `npm test`: **passed — 119 tests across 15 files** (84 earlier, plus 35 for the live check; 13 of the 35 are MOCK, and 1 uses the real local ffprobe).
- `npm run typecheck`: **passed**.
- `npm run lint`: **passed**.
- `npm run build`: **passed**; Next lists the planner and all voice API routes.
- Live provider/authenticated inventory result: **not tested**; no configured credentials were found and adapter tests use fixtures. An Azure live check is prepared. `npm run voice:live-check:plan` prints the requests with no network call, and `npm run voice:live-check` runs the check. The primary route is a manual GitHub Actions workflow at `fqmg-ohz-next/.github/workflows/voice-live-check.yml`, which is inert until it is placed at the repository root and on the default branch `main`. The check has **not been run**, and no provider was called.
- Verified Algerian voice result: **none verified for this application**; strict AUTO remains fail-closed absent evidence. This is not a claim that providers globally lack Algerian Arabic.
- Synthetic MP4 smoke test: **passed and ffprobe-validated**. Remotion composition render: **not rendered**, blocked on Chrome Headless Shell.

## 7. Acceptance/stop line

Phase 2 work remains limited to provider-independent voice, local managed cache/references, project metadata, and safe API interfaces. It does not implement audio mixing, generated subtitles, media QC, authentication, project database durability, cloud render workers, subscriptions, billing, Adobe integrations, Pinterest features, or Phase 3.
