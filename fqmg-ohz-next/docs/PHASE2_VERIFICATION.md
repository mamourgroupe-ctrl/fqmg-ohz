# Phase 2 integration verification

- **Verified:** 2026-10-09
- **Scope:** `fqmg-ohz-next/` only · branch `arena/ede0565d-fqmg-ohz` · PR #1 (open, not merged)
- **Outcome:** Code-level checks pass: 84 of 84 tests, typecheck, lint, and production build. Live provider calls were not possible because no credentials are configured. **No Remotion composition render was produced.** Chrome Headless Shell cannot be downloaded or installed from this sandbox. A Remotion bundle compile check passed; a bundle is not a render.

## Executive summary

- **Committed and pushed:** `2f9da61` (provider hardening, bundled-FFprobe resolver, `.gitignore`, report rename) on `arena/ede0565d-fqmg-ohz`. PR #1 includes it. PR #1 has not been merged.
- **Render unblock:** all four steps failed for environment reasons, recorded in Part B. Part C (render proof) was therefore not performed, and no MP4 from a Remotion composition exists.
- **Delivered instead:** a manual-only GitHub Actions smoke workflow at `fqmg-ohz-next/.github/workflows/render-smoke.yml`. It is inert until moved to the repository root, and it has not been run.
- **Bundle check:** `remotion bundle src/remotion/entry.tsx` exited 0. This shows the composition compiles through Remotion's bundler. It is not a render.
- **Providers:** no credentials, no live inventory, no synthesis. **No Algerian Arabic voice is verified.**
- **Issues to act on:**
  - OpenAI's model page labels GPT-4o Mini TTS "Deprecated" and states a 2,000-input-token maximum that the adapter does not enforce.
  - ElevenLabs no longer receives `language_code` for any model, which gives up language enforcement on models that accept it.
  - The Azure authentication-header discrepancy is unresolved.
  - The FFprobe path uses an internal `@remotion/renderer` API.

## Part A: Commit and repository hygiene

### Status and diff before the commit

- `git status`: 10 tracked files modified; `docs/phase-2-verification.md` untracked; nothing staged.
- `git diff --stat`: 10 files, 199 insertions, 45 deletions.

### Secret, environment, and artifact checks (before staging)

- The staged set was empty. The 12 committed files are all under `fqmg-ohz-next/`.
- Scanned all 14,617 added lines for key-shaped strings (OpenAI, AWS, Google, and GitHub tokens; PEM blocks; provider key assignments). **0 matches.** One placeholder-looking value exists in the repository-root `README.md`. That file is unchanged on this branch, and its value contains `xxxx`.
- `.env.example` contains variable names with empty secret values. The `VOICE_*` entries are non-secret defaults.
- No `.env*` files other than the tracked example are committed. No `node_modules`, no render output (`renders/` exists and is empty), and no caches are committed. `.next/`, `tsconfig.tsbuildinfo`, and `next-env.d.ts` exist on disk and are git-ignored.
- The repository's `commit-msg` hook appends an Arena co-author trailer. It was left unchanged.

### Explanation of the +14,617 lines

- Working tree against `main` before this commit: 14,543 tracked insertions plus 74 lines in the untracked report, for **+14,617**. There were 0 deletions, because every file is new relative to `main`.
- Of this, 14,389 lines were already on PR #1 from commit `27354da`. This work changed tracked files by +199 and −45 (net +154) and added the 74-line report.
- After commit `2f9da61`: 69 files, **+14,638 / −0** against `main`. The difference from 14,617 is the 21-line net `.gitignore` expansion.

Ten largest files by added lines:

| # | File | Added | Classification |
| --- | --- | ---: | --- |
| 1 | `fqmg-ohz-next/package-lock.json` | 7,151 | **Generated** lockfile. Kept, because `npm ci` needs it for reproducible installs. |
| 2 | `src/voice/routing/voice-engine.ts` | 789 | Source |
| 3 | `src/motion/schemas/motion-specification.ts` | 503 | Source |
| 4 | `tests/voice-engine.test.ts` | 368 | Test (contains MOCK tests) |
| 5 | `src/voice/cache/synthesis-cache.ts` | 366 | Source |
| 6 | `tests/voice-provider-adapters.test.ts` | 261 | Test (contains MOCK tests) |
| 7 | `src/voice/contracts/voice-contract.ts` | 254 | Source |
| 8 | `src/app/page.tsx` | 229 | Source |
| 9 | `tests/voice-providers.test.ts` | 217 | Test (contains MOCK tests) |
| 10 | `src/render/remotion/MotionComposition.tsx` | 213 | Source |

- The only generated file in the PR is the lockfile. Its change in this work (−28/+1 against the Phase 2 commit) adds `@remotion/renderer` as a direct dependency. npm then removes `"dev": true` from packages that are now production dependencies. All 493 `resolved` URLs point to `https://registry.npmjs.org/`.
- The PR contains no build output, binaries, media, or caches. `templates/phase-one-preview.json` is a required input for the composition and tests, not generated output.
- Nothing was removed from the diff, because no unnecessary tracked files were present.

### `.gitignore` changes

- Added: `out/` (the Remotion CLI's default output), `*.mp4`, `*.mov`, `*.webm`, `*.mkv`, `*.mp3`, `*.wav`, `*.m4a`, `*.aac`, `*.ogg`, `*.opus`, `*.flac`, `*.aiff`, and `.remotion/`. `renders/` is kept.
- Remotion's default browser and download cache is `node_modules/.remotion/`. The renderer derives that location in `getDownloadsCacheDir()`, and the existing `node_modules/` rule already ignores it.
- Verified with `git check-ignore`: `out/clip.mp4`, `renders/phase-one-preview.mp4`, `public/voice.mp3`, `node_modules/.remotion/…`, and `.remotion/…` are ignored. `templates/phase-one-preview.json`, `.env.example`, and this report are not.

### Rename and commit

- `docs/phase-2-verification.md` was renamed to `docs/PHASE2_VERIFICATION.md`. The file was untracked, so a plain `mv` was used; `git mv` applies only to tracked files. The link in `docs/phase-2-plan.md` was updated.
- Commit `2f9da61` was pushed to `arena/ede0565d-fqmg-ohz` (`27354da..2f9da61`). PR #1 shows `2f9da61` as its head, is OPEN, and has `mergedAt: null`.

## Part B: Unblocking Remotion's browser

| Step | Action | Result |
| --- | --- | --- |
| 1. Retry | `./node_modules/.bin/remotion browser ensure`, the binary that `npx` runs | **Failed.** It attempted `https://remotion.media/chromium-headless-shell-linux-x64-157.0.8080.0.zip?clear` and failed in about one second: `Error: Client network socket disconnected before secure TLS connection was established`, `code: 'ECONNRESET'`, `host: 'remotion.media'`, `port: 443`. The earlier session failed the same way. |
| 2. System browser | `command -v` for `chromium`, `chromium-browser`, `google-chrome`, `google-chrome-stable`, `google-chrome-beta`, `chrome`, `headless_shell`, `chrome-headless-shell`, `firefox`, and `msedge`. Checked `~/.cache/puppeteer`, `~/.cache/ms-playwright`, `~/.cache/remotion`, `/usr/lib/chromium*`, `/opt/google/chrome`, and `/snap/bin`. | **None found.** |
| 3. apt | Unprivileged `apt-get install -y chromium`: `E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)` and `E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?`. Passwordless `sudo` is available, so the install was retried with `sudo -n`: `E: Unable to locate package chromium`, because the package index could not be refreshed. `sudo -n apt-get update`: `Err:1 http://deb.debian.org/debian bookworm InRelease` followed by `Connection failed [IP: 151.101.194.132 80]`. bookworm-updates and bookworm-security failed the same way. | **Failed.** The package mirror is unreachable, so nothing can be installed. |
| 4. Document and workflow | Host reachability below; workflow written, not run. | Done. |

### Host reachability (from this sandbox)

| Host | Needed for | Result |
| --- | --- | --- |
| `remotion.media` | Default Chrome Headless Shell (`--chrome-mode headless-shell`) on Linux x64 with glibc 2.35 or newer. This sandbox has glibc 2.36. | TLS connection reset (`SSL_ERROR_SYSCALL`) |
| `storage.googleapis.com` | Fallback headless shell when glibc is older than 2.35, and `--chrome-mode chrome-for-testing`. | TLS connection reset |
| `deb.debian.org` | apt packages | HTTPS: TLS reset. HTTP (the configured apt source): empty reply from `curl`, then `Connection failed` from apt |
| `archive.ubuntu.com` | apt packages (reference) | TLS connection reset |
| `registry.npmjs.org` | npm packages, including the bundled FFmpeg and FFprobe in `@remotion/compositor-linux-x64-gnu` | HTTP 200 |
| `github.com` | Git and GitHub Actions | HTTP 200 |

Download URLs, derived from the installed `@remotion/renderer` 4.0.534 source:

- **Default:** `https://remotion.media/chromium-headless-shell-linux-x64-157.0.8080.0.zip?clear` (observed above).
- **Fallback:** `https://storage.googleapis.com/chrome-for-testing-public/157.0.8080.0/linux64/chrome-headless-shell-linux64.zip`.
- **`--chrome-mode chrome-for-testing`:** `https://storage.googleapis.com/chrome-for-testing-public/157.0.8080.0/linux64/chrome-linux64.zip`.

Downloads are cached in `node_modules/.remotion/`. Passing a valid `--browser-executable` path skips the download.

### Workflow written, not run

- **File:** `fqmg-ohz-next/.github/workflows/render-smoke.yml`.
- **Trigger:** `workflow_dispatch` only. There is no push or pull_request trigger, and the workflow has not been started. Its input `chrome_mode` is `headless-shell` (default) or `chrome-for-testing`.
- **Steps:** runs on `ubuntu-24.04` with Node 22 and `npm ci`. Runs `npx remotion browser ensure` in headless-shell mode only. Renders 2 seconds (`--frames=0-59 --scale=0.5`) of `FQMG-OHZ-NEXT-Preview`, which is 1080×1920 at 30 fps. Probes the MP4 with ffprobe and jq assertions: MP4 container, one video stream, and duration between 1.8 and 2.2 seconds. Uploads the MP4 and the ffprobe JSON as artifact `render-smoke-<run_id>`, retained for 7 days.
- **Placement:** GitHub reads workflows only from the repository-root `.github/workflows/`. This copy is therefore inert. To run it, move it to `.github/workflows/render-smoke.yml` at the repository root. Its steps already set `working-directory: fqmg-ohz-next`, so no edits are needed after the move. The root is outside this project's write scope, so the move is a user action.
- **Static checks:** the YAML parses. The only trigger is `workflow_dispatch`. All four `run:` blocks pass `bash -n`. The major tags `actions/checkout@v7`, `actions/setup-node@v7`, and `actions/upload-artifact@v7` exist, confirmed through the GitHub API.
- **Not verified:** whether GitHub-hosted runners can reach `remotion.media`, and whether Chrome Headless Shell needs extra system libraries on `ubuntu-24.04`.

### Not attempted, awaiting approval

- An npm-distributed Chromium binary, such as `@sparticuz/chromium`. `registry.npmjs.org` is reachable, so this route may work here. It was not tried because it falls outside the requested order and adds a third-party binary and a large dependency. Its suitability for Remotion is unknown.

## Part C: Render proof (not performed)

- Part C runs only if Part B succeeds, and it did not. No Remotion composition was rendered, no MP4 was produced, and no ffprobe output exists for a Remotion render. Nothing in this report claims one.
- **Compile check only:** `remotion bundle src/remotion/entry.tsx --out-dir=build/remotion-bundle` exited 0 and produced 27 MB of JavaScript bundles. Remotion's bundler compiled the composition. No browser was used. The bundle was removed afterward; `build/` is git-ignored.
- The separate synthetic MP4 test is described under "Chromium, FFmpeg, and MP4 results". It is a media-tool test, not a Remotion render.

## Part D: Results and test classification

### Final checks

The checks ran on the current tree, which includes the workflow file. No code changed after these runs.

| Command | Result |
| --- | --- |
| `npm test` | **84 passed of 84, 14 files**, exit 0 |
| `npm run typecheck` | **Passed**, exit 0 |
| `npm run lint` | **Passed**, exit 0 |
| `npm run build` | **Passed**, exit 0. Routes: `/` and `/_not-found` (static); `/api/generate`, `/api/voice/audio/[id]`, `/api/voice/providers`, and `/api/voice/synthesize` (dynamic) |

### MOCK classification

A test is **MOCK** when it replaces an external dependency with a stand-in: an injected fake `fetch`, a fake OAuth token provider, or a hand-written provider double. All other tests use real code, real temporary files, or pure logic.

**32 of 84 tests are MOCK:**

- **`tests/voice-engine.test.ts`: 12 of 12 MOCK.** Every test uses the hand-written `FixtureVoiceProvider` in place of real provider adapters. The routing, retry, pin, and health logic under test is the real engine. One test also uses a real temporary directory for pin persistence.
  - MOCK: prefers exact inventory locale evidence over a generic documented language
  - MOCK: fails closed for AUTO Algerian Arabic when only generic Arabic is documented
  - MOCK: allows an explicit voice ID with a clear unverified-capability disclosure
  - MOCK: permits approximate AUTO locale matching only with explicit opt-in and discloses it
  - MOCK: retries transient errors a bounded number of times, then discloses a provider fallback
  - MOCK: keeps the selected provider and voice pinned per project
  - MOCK: seeds a project pin from Motion Specification metadata inside the project lock and rejects conflicts
  - MOCK: reports provider health using recent API success rate and latency
  - MOCK: distinguishes an unavailable voice inventory from a successful empty inventory
  - MOCK: does not exceed configured retries or fallback providers
  - MOCK: reports no provider as ready when no credentials are configured
  - MOCK: rejects malformed requests before touching a provider
- **`tests/voice-providers.test.ts`: 10 of 10 MOCK.** Azure (4) and OpenAI (6) use an injected `vi.fn` fetch. No real request was sent.
  - MOCK: Azure "is not ready when credentials and endpoint configuration are absent"
  - MOCK: Azure "normalizes voice inventory records returned by the configured resource"
  - MOCK: Azure "sends escaped SSML and returns bounded MP3 bytes"
  - MOCK: Azure "classifies throttling as retryable without exposing a provider response body"
  - MOCK: OpenAI "uses the documented built-in voices but marks locale and dialect inventory unknown"
  - MOCK: OpenAI "posts the selected voice/model and validates the returned MP3"
  - MOCK: OpenAI "rejects unsupported instructions for legacy models before calling OpenAI"
  - MOCK: OpenAI "rejects input above OpenAI's documented 4096-character limit before calling the API"
  - MOCK: OpenAI "supports the documented dated mini TTS model alias"
  - MOCK: OpenAI "rejects insecure/custom base URLs before issuing a request"
- **`tests/voice-provider-adapters.test.ts`: 10 of 11 MOCK.** ElevenLabs (5) and Google Cloud (5) use an injected fetch. The Google tests also use a fake token provider.
  - MOCK: ElevenLabs "is not configured without an API key"
  - MOCK: ElevenLabs "discovers voice locales and dialect labels only from verified-language inventory"
  - MOCK: ElevenLabs "fails inventory discovery instead of silently using an incomplete capped page set"
  - MOCK: ElevenLabs "synthesizes a selected voice into validated MP3 audio"
  - MOCK: ElevenLabs "does not retry authentication failures"
  - MOCK: Google Cloud "does not attempt discovery when Google credentials are absent"
  - MOCK: Google Cloud "queries the exact locale and normalizes Google voice metadata"
  - MOCK: Google Cloud "uses OAuth and decodes only validated MP3 synthesis output"
  - MOCK: Google Cloud "rejects content above Google's 5000-byte request limit before obtaining credentials"
  - MOCK: Google Cloud "maps authentication errors safely and bounds credential acquisition by the request signal"
  - **Not MOCK:** "registers all four isolated providers without making network calls" checks provider IDs and unconfigured state. It does not spy on `fetch`, so it does not prove that no network call was made.

**52 of 84 tests are not MOCK:**

- `tests/render-job.test.ts`: 4 of 4. These use real temporary files. The synthetic MP4 test uses real FFmpeg and FFprobe, and is skipped automatically when the bundled binaries are absent. This run did not skip it.
- `tests/voice-synthesis-cache.test.ts`: 9 of 9, and `tests/project-voice-pin-store.test.ts`: 4 of 4. Both use real temporary directories.
- `tests/voice-api.test.ts`: 6 of 6. These use real request schemas and the real managed-audio route handler.
- `tests/voice-motion-integration.test.ts` (3), `tests/remotion-adapter.test.ts` (2), `tests/motion-specification.test.ts` (7), `tests/scene-planner.test.ts` (4), `tests/aspect-ratios.test.ts` (2), `tests/director-plan.test.ts` (3), and `tests/voice-contract.test.ts` (7): pure logic, no mocks.

## Chromium, FFmpeg, and MP4 results

- **Browser requirement:** Remotion's default is Chrome Headless Shell. The `--chrome-mode chrome-for-testing` option uses full Chrome for Testing instead. The URLs and hosts are listed in Part B.
- **Bundled media tools:** Remotion's compositor package `@remotion/compositor-linux-x64-gnu` (from npm) contains FFmpeg and FFprobe 7.1. `src/render/engine/render-job.ts` resolves the bundled FFprobe through `RenderInternals.getExecutablePath`, then falls back to `ffprobe` on `PATH`. `RenderInternals` is an internal API of `@remotion/renderer` 4.0.534. Recheck it on every upgrade.
- **System tools:** no `ffmpeg` or `ffprobe` is on `PATH`.
- **Synthetic MP4 test (passed; classification: not MOCK):** the test encodes a 24-frame H.264 MP4 at 160×90 and 24 fps with the bundled FFmpeg, then validates the file with `verifyRenderOutput` and `completeRenderJobWithOutput`. This validates the media tooling and the output gate only. It is **not** a Remotion composition render.

## Provider documentation cross-check

| Provider | Official contract reviewed | Finding and implementation result |
| --- | --- | --- |
| **Azure Speech** | Regional voice-list and synthesis endpoints, SSML, output-format header, and prosody. | Paths, SSML, MP3 format, and relative-rate mapping match the documented forms. **Discrepancy remains:** the TTS REST page's request-header table says `Authorization: Bearer` is required, but the linked REST-authentication reference says `Ocp-Apim-Subscription-Key` and Bearer are both accepted for TTS. The adapter sends the subscription-key header. No live resource was available to test it. Confirm the required header before production use. |
| **ElevenLabs** | Voice-list pagination and create-speech. | Pagination uses `has_more` and `next_page_token`, with `page_size` up to 100. The adapter now fails closed on loops or incomplete or capped inventories. Create-speech defaults `model_id` to `eleven_multilingual_v2`. It documents `language_code` as ISO 639-1, says it **"is not supported for multilingual_v2 models,"** and says an unsupported code is ignored. The adapter now never sends `language_code`, so it no longer sends regional tags such as `fr-FR` to the default model. **Tradeoff:** models that accept `language_code` get no language enforcement from this adapter. Not verified against a live voice. |
| **Google Cloud TTS** | `text:synthesize`, `voices.list`, OAuth scope, and quotas. | The REST endpoint and Cloud Platform scope match the docs. The quota page sets 5,000 bytes per request. The adapter now rejects text above 5,000 UTF-8 bytes before any token acquisition or network call. |
| **OpenAI TTS** | Create-speech API reference, GPT-4o Mini TTS model page, and TTS guide. | The API reference lists `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`, and `gpt-4o-mini-tts-2025-12-15`, and caps `input` at **4,096 characters**. The adapter enforces that cap. The API reference says `instructions` does not work with `tts-1` or `tts-1-hd`. The adapter limits style to mini-TTS models. **Two open items from the model page:** it states **"The maximum number of input tokens is 2000,"** which the adapter does not enforce, so Arabic text near 4,096 characters may still be rejected. It also shows a **"Deprecated"** label next to the model title and on snapshot entries. The extracted text does not make clear which entries carry the label. Confirm the status before relying on the `gpt-4o-mini-tts` default. |

Official references:

- [Microsoft text-to-speech REST API](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech), [REST authentication reference](https://github.com/MicrosoftDocs/azure-ai-docs/blob/main/articles/ai-services/speech-service/includes/cognitive-services-speech-service-rest-auth.md), and [SSML voice/prosody reference](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice)
- [ElevenLabs list voices](https://elevenlabs.io/docs/api-reference/voices/search) and [create speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)
- [Google Cloud `text:synthesize`](https://docs.cloud.google.com/text-to-speech/docs/reference/rest/v1/text/synthesize), [voice listing](https://docs.cloud.google.com/text-to-speech/docs/reference/rest/v1/voices/list), and [quotas and limits](https://cloud.google.com/text-to-speech/quotas)
- [OpenAI create-speech API reference](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create), [GPT-4o Mini TTS model page](https://developers.openai.com/api/docs/models/gpt-4o-mini-tts), and [text-to-speech guide](https://developers.openai.com/api/docs/guides/text-to-speech)

## Voice availability and credentials

Only presence checks were made. No secret value was printed or stored.

| Provider | Configuration observed |
| --- | --- |
| OpenAI | `OPENAI_API_KEY` absent |
| ElevenLabs | `ELEVENLABS_API_KEY` absent |
| Azure Speech | `AZURE_SPEECH_KEY` absent; region or endpoint absent |
| Google Cloud | `GOOGLE_CLOUD_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`, and default ADC absent |

`.env`, `.env.local`, and `.env.production` are absent. No provider inventory or synthesis was attempted. **No Algerian Arabic voice is verified for this application.** This does not show that any provider lacks one.

## User actions

Use variable names only. Store values in a secret manager or an untracked local environment file. Never paste them into chat or commit them.

1. **Provider credentials:** `OPENAI_API_KEY`; `ELEVENLABS_API_KEY`; `AZURE_SPEECH_KEY` with `AZURE_SPEECH_REGION` or `AZURE_SPEECH_ENDPOINT`; `GOOGLE_CLOUD_PROJECT` with `GOOGLE_APPLICATION_CREDENTIALS` (or working ADC).
2. **Live inventory:** after credentials are set, inspect each provider's returned locales. Do not treat generic Arabic as Algerian Arabic. Listen to candidate voices before accepting them.
3. **Azure header:** confirm which authentication header the selected resource requires for TTS.
4. **OpenAI:** confirm the status of `gpt-4o-mini-tts`, decide whether to pin `gpt-4o-mini-tts-2025-12-15`, and test Arabic text near the 4,096-character limit against the 2,000-token maximum.
5. **Render (choose one):**
   - Move `fqmg-ohz-next/.github/workflows/render-smoke.yml` to the repository-root `.github/workflows/`. Then start it from the Actions tab, with `chrome_mode` set to `headless-shell` or, as a fallback, `chrome-for-testing`. Hosted runners must be able to reach `remotion.media` or `storage.googleapis.com`.
   - Or, on a machine that can reach `remotion.media`, run `npx remotion browser ensure` and then `npm run render:preview`. To use an existing browser, pass `--browser-executable`.
   - Or approve or decline the npm-packaged Chromium trial described above.
6. **Pull request:** review and merge PR #1 when satisfied. The agent has not merged it.

## Repository state

- Branch `arena/ede0565d-fqmg-ohz`: `2f9da61` (Part A), plus the follow-up commit that adds this report update and the workflow file.
- PR #1: open, not merged.
- Cleanup: removed the 27 MB bundle output and an empty Remotion cache folder created during the attempts.
