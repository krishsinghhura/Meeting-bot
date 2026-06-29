import { MeetingSummaryInput, MeetingTranscript } from "./models";

// return summary given a transcript
export async function summarizeTranscript(
  transcript: MeetingTranscript,
): Promise<MeetingSummaryInput> {
  console.log("[summary-disabled] Transcript received for local logging:");
  console.dir(transcript, { depth: null });

  return {
    meetingId: transcript.meetingId,
    generatedAt: new Date(),
    summaryText: "Summary generation is disabled for this local setup.",
    model: "disabled",
  };
}
