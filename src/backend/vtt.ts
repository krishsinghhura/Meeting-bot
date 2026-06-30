import { mkdir, stat, writeFile } from "fs/promises";
import path from "path";
import { MeetingTranscript, Segment } from "../models";
import { saveMeetingArtifact } from "../storage";

const VTT_KIND = "transcript_vtt";
const VTT_MIME_TYPE = "text/vtt";

export async function createLocalVttArtifact(transcript: MeetingTranscript) {
  const outputDir = path.resolve(
    process.env.LOCAL_ARTIFACTS_DIR || "local-artifacts",
    "vtt",
  );
  await mkdir(outputDir, { recursive: true });

  const segments = transcript.segments
    .filter((segment) => segment.text.trim())
    .sort((a, b) => a.start - b.start);
  const storagePath = path.join(outputDir, `${transcript.meetingId}.vtt`);
  const generatedAt = new Date();

  await writeFile(storagePath, renderVtt(segments), "utf8");

  const file = await stat(storagePath);
  return await saveMeetingArtifact({
    meetingId: transcript.meetingId,
    kind: VTT_KIND,
    mimeType: VTT_MIME_TYPE,
    storagePath,
    fileSizeBytes: file.size,
    segmentCount: segments.length,
    generatedAt,
  });
}

export function renderVtt(segments: Segment[]) {
  const cues = segments
    .map((segment, index) => renderCue(segment, index + 1))
    .join("\n\n");
  return `WEBVTT\n\n${cues}${cues ? "\n" : ""}`;
}

function renderCue(segment: Segment, index: number) {
  const start = Math.max(0, segment.start);
  const end = Math.max(start + 1, segment.end);
  const speaker = escapeVttText(segment.speaker.trim() || "Unknown Speaker");
  const text = escapeVttText(segment.text.trim());

  return [
    String(index),
    `${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}`,
    `<v ${speaker}>${text}`,
  ].join("\n");
}

function formatVttTimestamp(totalSeconds: number) {
  const wholeSeconds = Math.floor(totalSeconds);
  const milliseconds = Math.round((totalSeconds - wholeSeconds) * 1000);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = wholeSeconds % 60;

  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    `${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`,
  ].join(":");
}

function escapeVttText(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
