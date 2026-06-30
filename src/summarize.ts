import type {
  MeetingAiResultInput,
  MeetingAnalysis,
  MeetingTranscript,
  Segment,
} from "./models";

export const MEETING_ANALYSIS_KIND = "meeting_analysis";

const DEFAULT_OPENAI_MODEL = "gpt-5.5";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MAX_TRANSCRIPT_CHARS = 60000;

const MEETING_ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    keyPoints: {
      type: "array",
      items: { type: "string" },
    },
    decisions: {
      type: "array",
      items: { type: "string" },
    },
    actionItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string" },
          owner: { type: ["string", "null"] },
          dueDate: { type: ["string", "null"] },
          priority: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["task", "owner", "dueDate", "priority"],
      },
    },
    questions: {
      type: "array",
      items: { type: "string" },
    },
    followUps: {
      type: "array",
      items: { type: "string" },
    },
    participants: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: [
    "title",
    "summary",
    "keyPoints",
    "decisions",
    "actionItems",
    "questions",
    "followUps",
    "participants",
  ],
};

export function isMeetingAnalysisEnabled() {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function getOpenAiModel() {
  return process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
}

export async function analyzeMeetingTranscript(
  transcript: MeetingTranscript,
): Promise<MeetingAiResultInput> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required to analyze a meeting transcript.",
    );
  }

  const cleanedTranscript = renderCleanTranscript(transcript);
  if (!cleanedTranscript.trim()) {
    throw new Error(
      `Meeting ${transcript.meetingId} has no transcript text to analyze.`,
    );
  }

  const model = getOpenAiModel();
  const response = await fetch(`${getOpenAiBaseUrl()}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: [
        "You are a meeting analyst.",
        "Use only the transcript content supplied by the user.",
        "Do not invent decisions, action item owners, dates, attendees, or follow-ups.",
        "Use null for unknown owners and due dates. Use [] when a section has no evidence.",
        "Keep the summary concise and useful for someone who missed the meeting.",
      ].join(" "),
      input: [
        `Meeting ID: ${transcript.meetingId}`,
        `Created at: ${transcript.createdAt.toISOString()}`,
        "",
        "Transcript:",
        cleanedTranscript,
      ].join("\n"),
      reasoning: {
        effort: process.env.OPENAI_REASONING_EFFORT || "low",
      },
      text: {
        verbosity: process.env.OPENAI_VERBOSITY || "low",
        format: {
          type: "json_schema",
          name: "meeting_analysis",
          strict: true,
          schema: MEETING_ANALYSIS_SCHEMA,
        },
      },
    }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = extractOpenAiErrorMessage(body) || response.statusText;
    throw new Error(
      `OpenAI meeting analysis failed (${response.status}): ${message}`,
    );
  }

  const outputText = extractResponseText(body);
  const outputJson = parseMeetingAnalysis(outputText);

  return {
    meetingId: transcript.meetingId,
    kind: MEETING_ANALYSIS_KIND,
    model,
    outputJson,
    generatedAt: new Date(),
  };
}

export function renderCleanTranscript(transcript: MeetingTranscript) {
  const maxChars = Number(
    process.env.OPENAI_TRANSCRIPT_MAX_CHARS || DEFAULT_MAX_TRANSCRIPT_CHARS,
  );
  const segments = cleanTranscriptSegments(transcript.segments);
  const lines = segments.map((segment) => {
    return [
      `[${formatClock(segment.start)}-${formatClock(segment.end)}]`,
      `${segment.speaker.trim() || "Unknown Speaker"}:`,
      segment.text.trim(),
    ].join(" ");
  });

  const rendered = lines.join("\n");
  return Number.isFinite(maxChars) && maxChars > 0
    ? rendered.slice(0, maxChars)
    : rendered;
}

export function cleanTranscriptSegments(segments: Segment[]) {
  const cleaned: Segment[] = [];
  const sorted = [...segments]
    .filter((segment) => segment.text.trim())
    .sort((a, b) => a.start - b.start || a.end - b.end);

  for (const segment of sorted) {
    const normalizedSegment = normalizeCaptionText(segment.text);
    if (!normalizedSegment) continue;

    const nextSegment = {
      ...segment,
      text: segment.text.trim(),
      speaker: segment.speaker.trim() || "Unknown Speaker",
    };
    const previous = cleaned[cleaned.length - 1];

    if (
      previous &&
      previous.speaker === nextSegment.speaker &&
      isIncrementalCaption(previous.text, nextSegment.text)
    ) {
      previous.end = Math.max(previous.end, nextSegment.end);
      if (
        normalizeCaptionText(nextSegment.text).length >=
        normalizeCaptionText(previous.text).length
      ) {
        previous.text = nextSegment.text;
      }
      continue;
    }

    if (previous && normalizeCaptionText(previous.text) === normalizedSegment) {
      previous.end = Math.max(previous.end, nextSegment.end);
      continue;
    }

    cleaned.push(nextSegment);
  }

  return cleaned;
}

function getOpenAiBaseUrl() {
  return (
    process.env.OPENAI_BASE_URL ||
    process.env.OPENAI_API_BASE_URL ||
    DEFAULT_OPENAI_BASE_URL
  ).replace(/\/+$/, "");
}

function parseMeetingAnalysis(outputText: string): MeetingAnalysis {
  if (!outputText) {
    throw new Error("OpenAI response did not include text output.");
  }

  const parsed = JSON.parse(outputText) as MeetingAnalysis;
  return {
    title: parsed.title || "",
    summary: parsed.summary || "",
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
    decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
    actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
    questions: Array.isArray(parsed.questions) ? parsed.questions : [],
    followUps: Array.isArray(parsed.followUps) ? parsed.followUps : [],
    participants: Array.isArray(parsed.participants) ? parsed.participants : [],
  };
}

function extractResponseText(body: unknown): string {
  if (!body || typeof body !== "object") return "";

  const responseBody = body as {
    output_text?: unknown;
    output?: {
      content?: {
        text?: unknown;
        output_text?: unknown;
      }[];
    }[];
  };

  if (typeof responseBody.output_text === "string") {
    return responseBody.output_text;
  }

  const textParts: string[] = [];
  for (const item of responseBody.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") textParts.push(content.text);
      if (typeof content.output_text === "string")
        textParts.push(content.output_text);
    }
  }

  return textParts.join("\n").trim();
}

function extractOpenAiErrorMessage(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const errorBody = body as {
    error?: { message?: unknown };
    message?: unknown;
  };
  if (typeof errorBody.error?.message === "string")
    return errorBody.error.message;
  if (typeof errorBody.message === "string") return errorBody.message;
  return null;
}

function isIncrementalCaption(previous: string, current: string) {
  const prev = normalizeCaptionText(previous);
  const curr = normalizeCaptionText(current);
  if (!prev || !curr) return false;
  if (prev === curr) return true;
  if (curr.startsWith(prev) || prev.startsWith(curr)) return true;
  return curr.includes(prev) && curr.length > prev.length;
}

function normalizeCaptionText(text: string) {
  return text
    .trim()
    .replace(/[.,!?;:]+/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function formatClock(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}
