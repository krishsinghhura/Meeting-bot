import { MeetingTranscript, Segment } from "../models";
import { saveMeetingArtifact } from "../storage";
import { getRequiredEnv } from "./env";

const VTT_KIND = "transcript_vtt";
const VTT_MIME_TYPE = "text/vtt";
const VTT_STORAGE_PREFIX = "vtt";

export async function createVttArtifact(transcript: MeetingTranscript) {
  const segments = transcript.segments
    .filter((segment) => segment.text.trim())
    .sort((a, b) => a.start - b.start);
  const vtt = renderVtt(segments);
  const fileSizeBytes = Buffer.byteLength(vtt, "utf8");
  const storagePath = await uploadVttToSupabase(transcript.meetingId, vtt);
  const generatedAt = new Date();

  return await saveMeetingArtifact({
    meetingId: transcript.meetingId,
    kind: VTT_KIND,
    mimeType: VTT_MIME_TYPE,
    storagePath,
    fileSizeBytes,
    segmentCount: segments.length,
    generatedAt,
  });
}

async function uploadVttToSupabase(meetingId: string, vtt: string) {
  const supabaseUrl = getRequiredEnv("SUPABASE_URL").replace(/\/+$/, "");
  const supabaseSecretKey =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "";
  if (!supabaseSecretKey) {
    throw new Error(
      "Missing required environment variable: SUPABASE_SECRET_KEY",
    );
  }

  const bucket = getRequiredEnv("SUPABASE_STORAGE_BUCKET");
  const objectPath = `${VTT_STORAGE_PREFIX}/${safeObjectName(meetingId)}.vtt`;
  const uploadUrl = `${supabaseUrl}/storage/v1/object/${encodePath(bucket)}/${encodeObjectPath(objectPath)}`;

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${supabaseSecretKey}`,
      apikey: supabaseSecretKey,
      "Cache-Control": "max-age=3600",
      "Content-Type": VTT_MIME_TYPE,
      "x-upsert": "true",
    },
    body: Buffer.from(vtt, "utf8"),
  });

  if (!response.ok) {
    throw new Error(
      `Supabase VTT upload failed (${response.status}): ${await readResponseMessage(response)}`,
    );
  }

  return getStoredArtifactUrl(supabaseUrl, bucket, objectPath);
}

function getStoredArtifactUrl(
  supabaseUrl: string,
  bucket: string,
  objectPath: string,
) {
  if (isPublicStorageBucket()) {
    return `${supabaseUrl}/storage/v1/object/public/${encodePath(bucket)}/${encodeObjectPath(objectPath)}`;
  }

  return `supabase://${bucket}/${objectPath}`;
}

function isPublicStorageBucket() {
  return ["1", "true", "yes", "public"].includes(
    (process.env.SUPABASE_STORAGE_PUBLIC || "").trim().toLowerCase(),
  );
}

function safeObjectName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function encodeObjectPath(value: string) {
  return value.split("/").map(encodePath).join("/");
}

function encodePath(value: string) {
  return encodeURIComponent(value);
}

async function readResponseMessage(response: Response) {
  const body = await response.text().catch(() => "");
  if (!body) return response.statusText;

  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Fall through to raw response text.
  }

  return body;
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
