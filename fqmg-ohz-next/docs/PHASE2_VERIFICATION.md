# Phase 2 integration verification

- **Verified:** 2026-10-09
- **Scope:** `fqmg-ohz-next/` only
- **Outcome:** Code-level integration verification and local media-tool smoke test passed. Live provider verification and a Remotion composition render remain blocked by missing credentials and Chrome Headless Shell, respectively.

## Executive summary

- Reviewed the four provider adapters and their tests against official API documentation. The request shapes and endpoints generally align. Verification found and fixed provider-specific issues: ElevenLabs was receiving an unsupported regional `language_code` for its default multilingual model; Google Cloud and OpenAI input limits were not enforced locally; OpenAI style instructions were advertised for legacy models that do not support them.
- Fixed render validation to prefer Remotion's bundled FFprobe, with a `ffprobe`-on-`PATH` fallback. Added a test that produces and inspects an actual synthetic MP4 with Remotion's bundled FFmpeg/FFprobe.
- `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` all pass.
- No provider credentials or Google ADC were configured. No provider request, account inventory, or synthesis was made. **No Algerian-Arabic voice is verified for this application.** This is not a claim that providers globally lack Algerian Arabic.
- The real Remotion composition render is still **not rendered**: Remotion could not download Chrome Headless Shell. The synthetic MP4 smoke test is successful, but is not a Remotion project render.

## Provider documentation cross-check

| Provider | Official contract reviewed | Finding and implementation result |
| --- | --- | --- |
| **Azure Speech** | Regional/resource voice-list and synthesis endpoints, SSML request format, output-format header, and SSML prosody behavior. | The adapter's resource and regional endpoint paths, SSML, MP3 format, and relative-rate mapping are consistent with the documented forms. **Documentation discrepancy remains:** the TTS REST page's request-header table says `Authorization: Bearer` is required, while Microsoft's linked REST-authentication reference says `Ocp-Apim-Subscription-Key` and Bearer are both supported for TTS. The adapter sends the subscription-key header. No live resource was available to resolve this conflict; confirm the required header for the selected Azure resource before production synthesis. |
| **ElevenLabs** | Voice search/list pagination and text-to-speech request. | The voices endpoint documents `page_size` up to 100 and pagination through `has_more` plus `next_page_token`; the adapter uses that contract and now rejects loops or a capped, incomplete inventory rather than returning partial results. The TTS `language_code` field is ISO 639-1 and is unsupported for `eleven_multilingual_v2`; the adapter now omits it rather than sending regional BCP-47 tags such as `fr-FR` to that model. MP3 output format and the `speed` setting remain in use. |
| **Google Cloud TTS** | `voices.list`, `text:synthesize`, OAuth scope, and current content quota. | The adapter uses the documented REST endpoint and Cloud Platform OAuth scope, and synthesizes MP3 from the returned voice locale. Google's quota page sets a 5,000-byte content limit per request; the adapter now rejects text above 5,000 UTF-8 bytes before token acquisition or network access. |
| **OpenAI TTS** | Create-speech API reference and text-to-speech guide. | Request fields, response format, model/voice selection, and Bearer authentication align. The API reference caps input at 4,096 characters and explicitly says `instructions` does not work with `tts-1` or `tts-1-hd`; the adapter now rejects over-limit input and advertises/sends freeform style only for supported mini-TTS models. It also recognizes the documented dated mini-TTS model alias. Generic Arabic generation is not evidence of Algerian dialect support, so profiles still expose no `ar-DZ` locale or verified dialect evidence. |

Official references reviewed:

- [Microsoft text-to-speech REST API](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech), [REST authentication reference](https://github.com/MicrosoftDocs/azure-ai-docs/blob/main/articles/ai-services/speech-service/includes/cognitive-services-speech-service-rest-auth.md), and [SSML voice/prosody reference](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice)
- [ElevenLabs list voices](https://elevenlabs.io/docs/api-reference/voices/search) and [create speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)
- [Google Cloud `text:synthesize`](https://docs.cloud.google.com/text-to-speech/docs/reference/rest/v1/text/synthesize), [voice listing](https://docs.cloud.google.com/text-to-speech/docs/reference/rest/v1/voices/list), and [quotas and limits](https://cloud.google.com/text-to-speech/quotas)
- [OpenAI create-speech API reference](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create) and [text-to-speech guide](https://developers.openai.com/api/docs/guides/text-to-speech)

### Voice availability and credentials

Only boolean configuration indicators were checked; no secret values were printed or stored.

| Provider | Configuration observed |
| --- | --- |
| OpenAI | `OPENAI_API_KEY` absent |
| ElevenLabs | `ELEVENLABS_API_KEY` absent |
| Azure Speech | key and region/resource endpoint absent |
| Google Cloud | project, credentials path/file, and default ADC file absent |

`.env`, `.env.local`, and `.env.production` are absent. Accordingly, no authenticated provider inventory or synthesis was attempted. Account-specific Azure, ElevenLabs, and Google voice availability was not observed. OpenAI's documented multilingual support does not verify a specific Algerian accent. Treat the application's Algerian-voice count as **unverified**, not as proof of global provider support or absence.

## Chromium, FFmpeg, and MP4 results

- The earlier `npm run render:preview` attempt stopped before frame rendering: Remotion tried to fetch Chrome Headless Shell and received `ECONNRESET` from `remotion.media`. No Chrome/Chromium executable is installed or cached in this environment, and no Remotion composition MP4 was produced.
- No system `ffmpeg` or `ffprobe` is on `PATH`. Remotion's Linux x64 compositor package does contain FFmpeg and FFprobe 7.1. `src/render/engine/render-job.ts` now resolves bundled FFprobe first and falls back to `ffprobe` on `PATH`.
- **Synthetic media smoke test: passed.** The test encoded a one-second black H.264 MP4 using the bundled FFmpeg and verified the actual file through `verifyRenderOutput` and `completeRenderJobWithOutput`. FFprobe reported MP4/MOV container family, H.264 video, 160×90, 24/1 fps, and 1.000000-second duration; the observed file size was 1,846 bytes. The temporary test file was cleaned up.
- This smoke test validates FFmpeg, FFprobe, and the file-validation gate only. It is **not** evidence that a Remotion composition rendered. Audio-bearing projects remain fail-closed by the existing renderer until audio mixing is implemented.

Remotion CLI help exposes `remotion browser ensure` and `--browser-executable`. Retry the project render only after a compatible Chrome Headless Shell/Chromium is installed or available through Remotion's browser cache.

## Final checks

| Check | Result |
| --- | --- |
| `npm test` | **Passed — 84 tests across 14 files** |
| `npm run typecheck` | **Passed** |
| `npm run lint` | **Passed** |
| `npm run build` | **Passed**; planner and voice API routes compiled |
| Synthetic MP4 + FFprobe validation | **Passed** |
| Live provider inventory/synthesis | **Not run — no configured credentials** |
| Algerian Arabic voice verified for this app | **No** |
| Remotion composition render | **Not rendered — Chrome Headless Shell unavailable** |

## User actions before end-to-end acceptance

1. Configure provider credentials in a secret store or untracked local environment file—never paste keys into chat or commit them. For Google, provide working ADC/service-account credentials and the project; for Azure, provide a key plus its matching region/resource endpoint.
2. Once configured, query each provider's live inventory and inspect its returned locale/dialect evidence. Do not treat generic Arabic or a documentation-only profile as an Algerian-Arabic voice. Listen to any candidate before treating its dialect quality as acceptable.
3. Keep Google synthesis content within 5,000 UTF-8 bytes and OpenAI TTS input within 4,096 characters per request. Automatic text chunking/audio stitching is not implemented.
4. Install or cache a compatible Chrome Headless Shell/Chromium in an environment that can reach Remotion's download host, or pass a compatible path with `--browser-executable`; then render the actual composition and inspect that MP4 with FFprobe.
5. Do not expose the synthesis API publicly until application authentication/authorization, rate limiting, and durable/shared storage are addressed. No Phase 3, Pinterest, Adobe, subscription, or billing work was started.

**Repository state:** changes are confined to `fqmg-ohz-next/`, remain local and uncommitted, and were not staged, pushed, or merged. PR #1 remains open and unmerged.
