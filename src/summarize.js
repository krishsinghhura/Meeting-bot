"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.summarizeTranscript = summarizeTranscript;
async function summarizeTranscript(transcript) {
  console.log("[summary-disabled] Transcript received for local logging:");
  console.dir(transcript, { depth: null });
  return {
    meetingId: transcript.meetingId,
    generatedAt: new Date(),
    summaryText: "Summary generation is disabled for this local setup.",
    model: "disabled",
  };
}
