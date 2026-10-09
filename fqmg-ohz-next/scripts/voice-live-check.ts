/**
 * Manual live voice check (Phase 2). Run with: npm run voice:live-check
 *
 * This prepares a real provider run. It needs real credentials in the environment (names only):
 *   VOICE_PROVIDER (optional, default "azure"), AZURE_SPEECH_KEY, and AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT.
 * Outputs go to voice-live-output/ (git-ignored): inventory.json, summary.json, and the MP3 sample.
 * See docs/PHASE2_VERIFICATION.md for the GitHub Actions procedure and the output to send back.
 */
import path from "node:path";
import { runVoiceLiveCheck } from "./lib/voice-live-check-core";

// Resolved from this file, not the working directory, so outputs always land in the git-ignored folder.
const outputDirectory = path.resolve(__dirname, "..", "voice-live-output");

runVoiceLiveCheck({
  environment: process.env,
  outputDirectory,
  log: (line) => console.log(line),
}).then(
  (result) => {
    process.exitCode = result.exitCode;
  },
  () => {
    console.error("ERROR: the voice live check stopped unexpectedly. No details are printed.");
    process.exitCode = 1;
  },
);
