# Phase 2 integration verification

- **Verified:** 2026-10-09
- **Scope:** `fqmg-ohz-next/` only · branch `arena/ede0565d-fqmg-ohz` · PR #1 (open, not merged)
- **Outcome:** Code-level checks pass on the final code: 119 of 119 tests (15 files), typecheck, lint, and production build. The Azure live voice check is prepared but **has not been run**, and no provider was called from this sandbox. **No Remotion composition render was produced.** Chrome Headless Shell cannot be downloaded or installed from this sandbox. A Remotion bundle compile check passed; a bundle is not a render.

## Executive summary

- **Committed and pushed:** `2f9da61` (provider hardening, bundled-FFprobe resolver, `.gitignore`, report rename) on `arena/ede0565d-fqmg-ohz`. PR #1 includes it. PR #1 has not been merged.
- **Render unblock:** all four steps failed for environment reasons, recorded in Part B. Part C (render proof) was therefore not performed, and no MP4 from a Remotion composition exists.
- **Delivered instead:** a manual-only GitHub Actions smoke workflow at `fqmg-ohz-next/.github/workflows/render-smoke.yml`. It is inert until moved to the repository root and to the default branch, and it has not been run.
- **Bundle check:** `remotion bundle src/remotion/entry.tsx` exited 0. This shows the composition compiles through Remotion's bundler. It is not a render.
- **Providers:** no credentials, no live inventory, no synthesis. **No Algerian Arabic voice is verified.**
- **Azure live voice check (prepared, not run):** the primary route is the manual GitHub Actions workflow `Voice live check (manual)`. It cannot start yet. The workflow must be placed at the repository root, and it must be on the default branch `main` for GitHub to show the **Run workflow** button. Both are decisions for you (see User actions). The local bash run is the secondary route. `npm run voice:live-check:plan` prints every request with no network call and no file. The live run, `npm run voice:live-check`, makes at most 7 requests and 50 characters on a regional endpoint, or 8 and 55 on a custom subdomain. Azure pricing was not verified here. The live run needs `AZURE_SPEECH_KEY` and either `AZURE_SPEECH_REGION` or `AZURE_SPEECH_ENDPOINT`. This sandbox cannot reach Azure, and the live run has not been approved or run. Steps: [Live voice check (Azure)](#live-voice-check-azure-prepared-not-run).
- **Issues to act on:**
  - OpenAI's model page labels GPT-4o Mini TTS "Deprecated" and states a 2,000-input-token maximum that the adapter does not enforce.
  - ElevenLabs no longer receives `language_code` for any model, which gives up language enforcement on models that accept it.
  - Azure's documentation is internally inconsistent about the synthesis header and path. Only a live run can settle it for one account, and the check that does so has not been run.
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
- **Placement:** GitHub reads workflows only from the repository-root `.github/workflows/`. This copy is therefore inert. To run it, move it to `.github/workflows/render-smoke.yml` at the repository root. Its steps already set `working-directory: fqmg-ohz-next`, so no edits are needed after the move. GitHub also shows the **Run workflow** button only when the file is on the default branch, so the copy must reach `main` as well. The root is outside this project's write scope, so the move is a user action.
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

The checks ran on 2026-10-09 on the final code, after the `:plan` script, the plan wording, and the CLI comment were in place. No code changed after these runs. Afterward, only report text and one comment in the workflow file were edited.

| Command | Result |
| --- | --- |
| `npm ci` | Installed 401 packages from `registry.npmjs.org`. npm reported 0 vulnerabilities. `package-lock.json` unchanged. |
| `npm test` | **119 passed of 119, 15 files**, exit 0. Includes 35 tests in `tests/voice-live-check.test.ts` (21 pure, 13 MOCK, and 1 real local ffprobe). None of them calls a provider. |
| `npm run typecheck` | **Passed**, exit 0 |
| `npm run lint` | **Passed**, exit 0 |
| `npm run build` | **Passed**, exit 0. Routes unchanged: `/` and `/_not-found` (static); `/api/generate`, `/api/voice/audio/[id]`, `/api/voice/providers`, and `/api/voice/synthesize` (dynamic) |

### MOCK classification

A test is **MOCK** when it replaces an external dependency with a stand-in: an injected fake `fetch`, a fake OAuth token provider, or a hand-written provider double. All other tests use real code, real temporary files, or pure logic.

**45 of 119 tests are MOCK:** the 32 tests in the earlier suites, plus 13 in `tests/voice-live-check.test.ts`.

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

- **`tests/voice-live-check.test.ts`: 13 of 35 MOCK.** These use a fake Azure `fetch` and a fake ffprobe probe. No provider was called. They test the live check's own logic, not Azure. Four of them are plan and endpoint tests that spy on `fetch` and assert that no request is made.
  - MOCK: makes no provider request when credentials are missing
  - MOCK: makes no provider request for an unsupported provider
  - MOCK: refuses a key pasted into the region variable before any request, without echoing it
  - MOCK: plan mode prints the plan with zero requests and writes no files
  - MOCK: plan mode accepts a valid custom-subdomain endpoint and still makes no request
  - MOCK: plan mode still fails closed on bad configuration and prints no plan
  - MOCK: refuses a key placed in the endpoint variable, or a key-shaped endpoint label, before any request
  - MOCK: passes the pipeline with an ar-DZ voice, lists every voice, and keeps the key out of all outputs
  - MOCK: labels a non-Algerian fallback clearly and reports ar-DZ as not returned
  - MOCK: stops at step 2 when the adapter's key form fails on synthesis but Bearer works, and says so
  - MOCK: fails at step 1 when the inventory returns no Arabic voice, without attempting synthesis
  - MOCK: replaces a stale passing summary and stale audio from an earlier run
  - MOCK: fails at step 4 when ffprobe reports a non-MP3 file, and keeps the file for diagnosis

**74 of 119 tests are not MOCK:**

- `tests/voice-live-check.test.ts`: 22 of 35 not MOCK. 21 are pure logic (locale filtering, ar-DZ detection, voice selection, secret redaction, status classification, route and token-URL derivation, ffprobe parsing and validation, diagnosis wording, argument parsing, key-placement detection, and the plan's description and counts), labeled not provider proof. 1 runs the real bundled ffprobe on an MP3 encoded by the bundled libmp3lame. It is skipped automatically when the binaries are absent. This run did not skip it.
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
| **Azure Speech** | Voice list, token issuance, synthesis, SSML, output format, and prosody. | Paths, SSML, MP3 format, and relative-rate mapping match Microsoft's documented forms. These are documented forms, not live results. **Header form (corrected 2026-10-09):** the page is internally inconsistent. Its authentication table lists both `Ocp-Apim-Subscription-Key` and `Authorization: Bearer` as accepted for text to speech. Its "Convert text to speech" request-header table lists `Authorization` as Required and does not list the subscription-key header at all. The token exchange takes the key in `Ocp-Apim-Subscription-Key`. The adapter sends only the key header, which the authentication table accepts. **Path:** Microsoft's "How to synthesize speech" page (February 2026) uses `https://YourResourceName.cognitiveservices.azure.com/tts/cognitiveservices/v1` with the key header on a custom subdomain, which is the adapter's path. The REST page's sample uses `/cognitiveservices/v1` on the same host. The live check tests both. **Algerian voices:** Microsoft's Azure AI Foundry blog (November 2024) lists `ar-DZ` voices Amina and Ismael. That is documentation only. The language-support page was not re-read, and nothing here is evidence for this account. |
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

## Live voice check (Azure): prepared, not run

**Status:** prepared and checked locally. **Not run.** No request has been sent to any provider from this sandbox, and no audio or summary exists. This sandbox can reach only `github.com`, `codeload.github.com`, `api.github.com`, `registry.npmjs.org`, `pypi.org`, and `files.pythonhosted.org`. The live run therefore has to happen on a GitHub runner (primary route) or on your machine (secondary route). Nothing in this report describes Azure behavior for your account until a real run exists.

**Routes:**

- **Primary: GitHub Actions, manual.** Needs your repository secrets and the placement decision in User actions. See [Primary route](#primary-route-github-actions-manual).
- **Secondary: local run in bash.** Needs a computer with a terminal. See [Secondary route](#secondary-route-local-run-in-bash).

### What the check does

`npm run voice:live-check` runs `scripts/voice-live-check.ts`, with the logic in `scripts/lib/voice-live-check-core.ts`.

1. **Inventory.** Calls the Phase 2 adapter's `listVoices("")`. An empty language tag skips the adapter's base-language filter, so the result includes every voice. The run prints the Arabic (`ar-*`) locales with counts, states whether any `ar-DZ` voice was returned, and writes the full list to `inventory.json`. Only an `ar-DZ` locale tag counts as Algerian. `ar-SA`, `ar-EG`, and MSA are reported as NOT Algerian.
2. **Auth check.** Sends raw requests that compare the two header forms, and records status codes only:
   - Token: `POST` to `issueToken` with `Ocp-Apim-Subscription-Key`.
   - Voice list: once with `Authorization: Bearer`, and once with `Ocp-Apim-Subscription-Key`. The Bearer probes run only if the token request succeeded.
   - Synthesis of one 5-character Arabic word: with `Authorization: Bearer` (if a token was issued), and with `Ocp-Apim-Subscription-Key` on the adapter's path. A custom-subdomain endpoint also tests `/cognitiveservices/v1` with the key.
   - The step passes only when the adapter's own form (the key header on the adapter's synthesis path) gets a 2xx. A 400 or 404 is a request problem, not an authentication result. If the key is rejected while Bearer works, or the alternate path works, the output says the adapter must change. The check does not change the adapter.
3. **Synthesis.** One short neutral Modern Standard Arabic sentence of 40 characters. It uses an `ar-DZ` voice if the inventory returned one. Otherwise it uses one other Arabic voice and labels it NOT ALGERIAN. There is no silent fallback: if the `ar-DZ` voice fails, the run fails.
4. **Verify.** ffprobe checks the saved file on the machine that runs the check. It uses the bundled binary from `@remotion/renderer`, through the same resolver as the render code. The run fails if the file is empty, is not MP3, or has no positive duration or sample rate. It reports codec, container, duration, sample rate, channels, and size.

### Plan mode: `npm run voice:live-check:plan` (no network, no files)

Use the plan script. It checks the configuration exactly as a live run does, then prints each request the live run would send: the URL, the header **name** (never a value), the request count, the number of text characters, the output file names, and the exit codes. It makes no network call and writes no file. Exit 0 means the configuration is complete. Exit 2 means a configuration problem, and no plan is printed.

**Do not add `--plan` after `voice:live-check`.** npm consumes a flag that follows a script name without a preceding `--`. `npm run voice:live-check --plan` therefore drops the flag and runs the live check. This was checked in this sandbox: a test script received no arguments from `npm run show --plan`, and the real script, run with no credentials set, printed its credential-missing message instead of a plan. The separate plan script avoids the problem.

The plan below is real output from this sandbox. It used the placeholder `TEST-KEY-not-a-secret-0123456789`, which is not a credential, and `AZURE_SPEECH_REGION=eastus`. No request was made, and no file was written.

```text
Provider: azure-speech. Credential presence (names only): AZURE_SPEECH_KEY present, AZURE_SPEECH_REGION present, AZURE_SPEECH_ENDPOINT absent.
Endpoint: regional, origin https://eastus.tts.speech.microsoft.com
Step 1, inventory: GET https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list with header Ocp-Apim-Subscription-Key. 1 request.
Step 2, auth check: POST https://eastus.api.cognitive.microsoft.com/sts/v1.0/issueToken with header Ocp-Apim-Subscription-Key, to obtain a token.
  Then GET https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list with header Authorization: Bearer, and again with Ocp-Apim-Subscription-Key.
  Then POST https://eastus.tts.speech.microsoft.com/cognitiveservices/v1 with one Arabic word (5 characters), with header Authorization: Bearer, and again with Ocp-Apim-Subscription-Key.
  Bearer requests run only if the token request succeeded.
  Step 2 sends at most 5 requests.
Step 3, synthesis: POST https://eastus.tts.speech.microsoft.com/cognitiveservices/v1 with one Arabic sentence (40 characters) and header Ocp-Apim-Subscription-Key. It uses an ar-DZ voice if the inventory returns one; otherwise another Arabic voice, labeled NOT ALGERIAN. 1 request.
Step 4, verify: ffprobe on the saved MP3, on the machine that runs the check. No network.
Total: at most 7 requests. Text sent for synthesis: at most 50 characters (2 probe words plus the sentence). SSML markup and billing rules are not counted here.
Outputs, under the package folder only: voice-live-output/summary.json, voice-live-output/inventory.json, and voice-live-output/azure-speech-<voiceId>.mp3. The folder is git-ignored.
Exit codes for a live run: 0 passed, 1 a step failed, 2 configuration problem (no request made).
PLAN ONLY: this mode makes no network request and writes no file. To send the requests listed above, run npm run voice:live-check with no flags.
```

With `AZURE_SPEECH_ENDPOINT=https://demo-resource.cognitiveservices.azure.com` instead, the plan has the same steps on that host. Step 2 adds the `/cognitiveservices/v1` probe, so it sends at most 6 requests. The totals are **8 requests and 55 characters**.

### Arguments

The script accepts only `--plan`. Any other argument exits 2 with a message, and no request is made. The rejected argument is never printed, because it might contain a key. This protects against typos in the script's own arguments. It does not change how npm reads flags, which is why the plan has its own script name.

### Exit codes and outputs

- **0:** all four steps passed (live run), or the plan was printed (`voice:live-check:plan`). **1:** a step failed; `summary.json` records `failedStep`. **2:** configuration is missing or unsupported: `VOICE_PROVIDER` other than `azure` or `azure-speech`, a missing key, a region or endpoint in an invalid format, a key placed in the region or the endpoint, or an unknown argument. No request is made and no output is written.
- **Outputs** go to `fqmg-ohz-next/voice-live-output/`, which is git-ignored: `summary.json`, `inventory.json`, and one `azure-speech-<voiceId>.mp3`. A live run that passes the configuration checks first removes earlier copies of these three kinds of file, so an old summary cannot be mistaken for a new result. A plan run removes nothing and writes nothing.
- **Secrets:** read only from environment variables. The console and `summary.json` show variable presence only (names and yes or no), never values, headers, or tokens. The console output, `summary.json`, and `inventory.json` pass through a redaction step. The MP3 is binary provider audio, so the leak check below looks at it as well.
- **Key placement:** a key pasted into `AZURE_SPEECH_REGION` is refused before any request, because the adapter's region pattern accepts a 32-character hexadecimal value. A key in `AZURE_SPEECH_ENDPOINT` is refused the same way, whether it appears as text in the host or as a 32-character hexadecimal host label, because either would be sent in a hostname. The messages never repeat the value.

### Requests and cost

Per live run, at most:

| | Regional (`AZURE_SPEECH_REGION`) | Custom subdomain (`AZURE_SPEECH_ENDPOINT`) |
|---|---|---|
| Requests | 7 | 8 |
| Text characters sent for synthesis | 2 probe words × 5 + 40-character sentence = **50** | 3 probe words × 5 + 40 = **55** |

The counts are maxima. Bearer requests run only after the token request succeeds. Each run repeats the same requests and characters, so a second run adds the same amount again.

**Charges:** Azure bills Speech by the pricing for your resource and region. This report does not state prices, and it did not verify which of these calls are metered or the current rate. Check Azure's pricing page for your region before you approve a run. If your Speech resource is on a free tier, check its monthly allowance in the portal; the tier limits are not verified here.

### Primary route: GitHub Actions (manual)

The workflow is `Voice live check (manual)`. It runs only when you start it, and each run makes real, billable provider requests. **It has not been run, and it cannot start yet.** Two things must be in place first. Both are decisions for you:

1. **Placement at the repository root.** GitHub reads workflows only from the repository-root `.github/workflows/`. The copy at `fqmg-ohz-next/.github/workflows/voice-live-check.yml` is inert. Its steps already set `working-directory: fqmg-ohz-next`, so the file needs no edits after it is copied.
2. **The default branch.** GitHub's documentation says that a `workflow_dispatch` workflow runs only if its file exists on the default branch, and that the **Run workflow** button appears only in that case. This repository's default branch is `main`. The run uses the branch you select, so that branch must also contain the root file.

This sandbox has not copied the file to the root or to `main`, and it will not do so without your approval.

Once both are in place:

1. **Create the repository secrets.** Go to Settings, then Secrets and variables, then Actions, then New repository secret. Create these names. Never paste a value into chat, a file, or a commit.
   - `AZURE_SPEECH_KEY`: required.
   - `AZURE_SPEECH_REGION` **or** `AZURE_SPEECH_ENDPOINT`: set exactly one. A secret that is not set arrives as an empty value, and the script treats an empty value as absent.
2. **Start the run.** Open the Actions tab, choose "Voice live check (manual)", choose **Run workflow**, select the branch `arena/ede0565d-fqmg-ohz`, keep `provider` as `azure`, and start the run. The run sends the requests listed in the plan: at most 7 requests and 50 characters on a regional endpoint, or 8 and 55 on a custom subdomain.
3. **Read the result.** The log's last `RESULT:` line says what happened. The job fails unless both the check and the leak scan passed.
4. **Download the artifact** `voice-live-check-azure-<run_id>`. It is kept for 7 days and holds `summary.json`, `inventory.json`, and the MP3. It is uploaded only after the leak scan passes.

The workflow has no plan mode. Use the plan sample above to see what your endpoint type will send.

### Secondary route: local run in bash

This route runs on your own machine. It needs a terminal that runs bash or zsh (macOS, Linux, or WSL), `git`, Node.js 22 with npm, and a Speech resource in your Azure subscription. No separate ffmpeg install is needed, because ffprobe comes from the npm packages that `npm ci` installs. Only the Linux x64 package was exercised in this sandbox. The commands below passed `bash -n` here. They have not been run against Azure.

**Credential names** (set these in your shell, and never in a file you commit):

- `AZURE_SPEECH_KEY`: required. Use KEY 1 from the resource's **Keys and Endpoint** page.
- Exactly one of `AZURE_SPEECH_REGION` (the short name, for example `eastus`, from the resource's **Location**) or `AZURE_SPEECH_ENDPOINT` (the resource endpoint with no key and no path, such as `https://<resource-name>.cognitiveservices.azure.com`).
- Optional: `VOICE_PROVIDER`, which defaults to `azure`.

If both region and endpoint are set, the endpoint is used, so set only one. The script reads the process environment only. It does not read a `.env` file.

```bash
# 0. Get the branch and install dependencies. npm downloads packages; nothing is sent to Azure here.
git clone https://github.com/mamourgroupe-ctrl/fqmg-ohz.git   # skip if you already have the repository
cd fqmg-ohz
git fetch origin
git switch arena/ede0565d-fqmg-ohz
git pull --ff-only origin arena/ede0565d-fqmg-ohz
cd fqmg-ohz-next
npm ci

# 1. Enter the key at a hidden prompt. It is not printed, not written to disk, and not in shell history.
printf 'AZURE_SPEECH_KEY (input hidden): '
read -rs AZURE_SPEECH_KEY
printf '\n'
export AZURE_SPEECH_KEY

# 2. Enter the region. Set only one of AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT.
printf 'AZURE_SPEECH_REGION (for example eastus): '
read -r AZURE_SPEECH_REGION
export AZURE_SPEECH_REGION

# 3. Plan: prints every request. No network call and no file. Exit 0 means the configuration is complete.
npm run voice:live-check:plan

# 4. LIVE RUN: sends the requests listed in the plan, from your machine. Run this only after you approve the plan.
npm run voice:live-check

# 5. Leak check: prints only the names of files that contain the key value. Expect the last message.
[ -n "$AZURE_SPEECH_KEY" ] && { grep -rlF -- "$AZURE_SPEECH_KEY" voice-live-output/ || echo "no output file contains the key value"; }

# 6. Remove the credentials from this shell.
unset AZURE_SPEECH_KEY AZURE_SPEECH_REGION
```

If step 5 lists any file, stop. Delete the listed files from `voice-live-output/`, then rotate the key in the Azure portal.

### What the output files contain

- **`summary.json`:** a few kilobytes. The result, each step's outcome, status codes, the header-form outcome, the voice names and locales used, the ffprobe fields, and the failed step if there was one. It contains no key, token, or header value. It does include the region or endpoint host and the voice IDs, so read it before you share it.
- **`inventory.json`:** one entry per voice the Speech service returns for your account (name, locale, gender). Its size depends on the voice list.
- **`azure-speech-<voiceId>.mp3`:** the synthesized sample: 24 kHz mono MP3 at 160 kbps, about 20 KB per second of audio. The 40-character sentence is a few seconds long.

### What to send back

- The final `RESULT:` line from the console or the log, and whether the run passed or failed. If the run stopped before step 1 (exit 2), send the configuration message instead. It names the problem and never shows a value.
- `summary.json`, after you have read it. It has no secrets, but it includes the region or endpoint host and the voice IDs.
- One listening note on the MP3: is the Arabic sentence intelligible, and does the accent sound Algerian to you? The check cannot judge accent.
- `inventory.json`, only if the full voice list is needed.
- Never send a key, a token, or a screenshot of a secret setting. If a key value ever appears in output, rotate the key.

### How to read the result

- **`RESULT: PASSED.`** The account's inventory returned an `ar-DZ` voice, and an `ar-DZ` sample was synthesized and passed ffprobe. Accent is still a listening judgment.
- **`RESULT: PIPELINE PASSED, ALGERIAN NOT VERIFIED.`** The account returned no `ar-DZ` voice. The saved sample uses a NON-Algerian Arabic voice. Do not describe it as Algerian.
- **`RESULT: FAILED at step 2.`** Read the auth probe lines in `summary.json`. The message says whether the adapter must change.
- **`RESULT: FAILED at step 1, 3, or 4.`** Send `summary.json`.
- **Exit 2, no output files.** A secret is missing, the region or endpoint format is invalid, a key was placed in the region or the endpoint, or an unknown argument was given. Fix the variable or argument. No provider request was made.

### The workflow file (details)

- **Location:** `fqmg-ohz-next/.github/workflows/voice-live-check.yml`. It is not moved and not enabled. The placement conditions are in the primary route above.
- **Trigger:** `workflow_dispatch` only, with a `provider` choice input (`azure`). It is not triggered by pushes or pull requests.
- **Secrets:** passed only to the steps that need them, as `secrets.AZURE_SPEECH_KEY`, `secrets.AZURE_SPEECH_REGION`, and `secrets.AZURE_SPEECH_ENDPOINT`. They are never set at job or workflow level.
- **Order:** install (Node 22, `npm ci`); the check, with `continue-on-error`, so its outputs are still scanned; the leak scan; the upload, which runs only if the scan passed; and a final gate that fails the job if the check or the scan did not pass.
- **Leak scan:** blocks the upload if the key value appears in any output file, or a token-shaped string appears in a JSON output. It prints a description and a file count only, never a matched value.
- **Artifact:** `voice-live-check-azure-<run_id>`, kept for 7 days. **Concurrency:** one run at a time.
- **Static checks:** `actionlint` could not be installed here. Its release download failed with a TLS error (`SSL_ERROR_SYSCALL`), and no PyPI wheel was available for this Python. Substitutes: `check-jsonschema` against the bundled GitHub workflow schema (passed for both workflows), ShellCheck on every `run:` block (clean), and the leak-scan tests. The action tags `actions/checkout@v7`, `actions/setup-node@v7`, and `actions/upload-artifact@v7` were re-confirmed through the GitHub API on 2026-10-09.

### Testing of the check itself (not provider proof)

`tests/voice-live-check.test.ts` has 35 tests. They ran on 2026-10-09 after `npm ci`, and **35 of 35 passed**. Their labels say what each one proves:

- **Pure logic, 21 tests, not provider proof:** locale filtering, ar-DZ detection, voice selection, secret redaction, status classification, route and token-URL derivation, ffprobe parsing and validation, auth diagnosis wording, argument parsing, key-placement detection, and the plan's description and counts.
- **MOCK flow, 13 tests:** a fake Azure `fetch` and a fake ffprobe probe. They cover refusal with zero requests, plan mode with a `fetch` spy that must see zero calls, a passing ar-DZ run, the non-Algerian fallback, an auth-step failure, an inventory with no Arabic voice, a non-MP3 file, stale-output replacement, and a key placed in the region or the endpoint.
- **Real local tool, 1 test:** ffprobe reads an MP3 encoded by the bundled libmp3lame. It is skipped automatically if the bundled binaries are absent. This run did not skip it.

Passing these tests shows the code's logic and its refusal paths. It does not show anything about Azure.

## User actions

Use variable names only. Store values in a secret manager or an untracked local environment file. Never paste them into chat or commit them.

1. **Provider credentials:** `OPENAI_API_KEY`; `ELEVENLABS_API_KEY`; `AZURE_SPEECH_KEY` with `AZURE_SPEECH_REGION` or `AZURE_SPEECH_ENDPOINT`; `GOOGLE_CLOUD_PROJECT` with `GOOGLE_APPLICATION_CREDENTIALS` (or working ADC).
2. **Live inventory:** after credentials are set, inspect each provider's returned locales (for Azure, see the live check above). Do not treat generic Arabic as Algerian Arabic. Listen to candidate voices before accepting them.
3. **Decide the workflow placement (this blocks the primary Azure route).** Choose one:
   - (a) Approve the agent adding `.github/workflows/voice-live-check.yml` at the repository root on this branch. Then add the same file to `main` yourself, for example through GitHub's web editor, or through a pull request you open.
   - (b) Copy the file to the repository root on both `main` and this branch yourself.

   Until one of these is done, the GitHub route cannot run. The local route needs neither.
4. **Azure live check (needs your approval):** choose a route. For the primary route, complete item 3 first. Before you approve a run, read the plan: run `npm run voice:live-check:plan` locally, or use the plan sample in this report. Check Azure's pricing for your region. The live run answers the header and path questions for your account. It has not been run.
5. **OpenAI:** confirm the status of `gpt-4o-mini-tts`, decide whether to pin `gpt-4o-mini-tts-2025-12-15`, and test Arabic text near the 4,096-character limit against the 2,000-token maximum.
6. **Render (choose one):**
   - Move `fqmg-ohz-next/.github/workflows/render-smoke.yml` to the repository-root `.github/workflows/`. Put the same file on `main` as well, because the **Run workflow** button needs the default branch. Then start it from the Actions tab, with `chrome_mode` set to `headless-shell` or, as a fallback, `chrome-for-testing`. Hosted runners must be able to reach `remotion.media` or `storage.googleapis.com`.
   - Or, on a machine that can reach `remotion.media`, run `npx remotion browser ensure` and then `npm run render:preview`. To use an existing browser, pass `--browser-executable`.
   - Or approve or decline the npm-packaged Chromium trial described above.
7. **Pull request:** review and merge PR #1 when satisfied. The agent has not merged it.

## Repository state

- Branch `arena/ede0565d-fqmg-ohz`. Before this work, the local branch was fast-forwarded from `1bf1d86` to `577d890` on `origin`. No force push, reset, or rebase was used.
- History on the branch: `27354da` (Phase 2 voice engine), `2f9da61` (Phase 2 verification), `3b106ae` (render attempts and the render smoke workflow), `a684254` (manual Azure live check, prepared), and `577d890` (report wording). The commit for this work follows `577d890`.
- This work's commit contains: `package.json` (new `voice:live-check:plan` script), `scripts/lib/voice-live-check-core.ts` (plan mode and argument parsing), `scripts/voice-live-check.ts` (the CLI), `tests/voice-live-check.test.ts` (35 tests), `docs/PHASE2_VERIFICATION.md`, and `docs/phase-2-plan.md` (test counts and routes).
- Lockfile: unchanged in this work. `npm ci` installed from it. The `tsx` 4.23.15 devDependency and the `voice:live-check` script were added earlier, in `a684254`.
- No `.github/workflows/` directory exists at the repository root. Both workflow files are under `fqmg-ohz-next/.github/workflows/`.
- PR #1: open, not merged, base `main`, head this branch. The agent has not merged it.
- No live provider call, no render, and no output files were created. `voice-live-output/` does not exist in the working tree.
- `npm ci` installed 401 packages from `registry.npmjs.org`. npm reported 0 vulnerabilities.
