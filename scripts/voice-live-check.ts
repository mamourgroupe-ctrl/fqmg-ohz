/**
 * Manual live voice check (Phase 2). Run from the repository root:
 *   npm run voice:live-check:plan   prints exactly what a live run would send. No request, no file.
 *   npm run voice:live-check        LIVE: sends the requests the plan lists, on your own machine.
 *   Do not append --plan to voice:live-check: npm drops it, and the live run starts instead.
 *
 * Credentials come only from the environment (names only):
 *   VOICE_PROVIDER (optional, default "azure"), AZURE_SPEECH_KEY, and AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT.
 * Outputs go to voice-live-output/ (git-ignored): inventory.json, summary.json, and the MP3 sample.
 * See docs/PHASE2_VERIFICATION.md for the local run procedure and the output to send back.
 */
import path from "node:path";
import { parseVoiceLiveCheckArgs, runVoiceLiveCheck } from "./lib/voice-live-check-core";

// Resolved from this file, not the working directory, so outputs always land in the git-ignored folder.
const outputDirectory = path.resolve(__dirname, "..", "voice-live-output");

const parsed = parseVoiceLiveCheckArgs(process.argv.slice(2));
if (!parsed.ok) {
  // Unknown arguments fail closed: no request and no file. The argument itself is never printed.
  console.log(parsed.message);
  process.exitCode = 2;
} else {
  runVoiceLiveCheck({
    environment: process.env,
    outputDirectory,
    log: (line) => console.log(line),
    plan: parsed.plan,
  }).then(
    (result) => {
      process.exitCode = result.exitCode;
    },
    () => {
      console.error("ERROR: the voice live check stopped unexpectedly. No details are printed.");
      process.exitCode = 1;
    },
  );
}
