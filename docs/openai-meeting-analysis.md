# OpenAI Meeting Analysis

This document describes the LLM analysis step that runs after a meeting transcript is saved. It covers when the OpenAI call happens, what payload is sent to the model, what JSON output is expected, where the result is stored, and how to test it manually.

Implementation files:

- `src/summarize.ts` builds the OpenAI request, cleans transcript segments, and parses the model output.
- `src/backend/server.ts` calls the analyzer after VTT artifact creation.
- `scripts/summarize-meeting.js` runs the same analyzer for an existing saved transcript.
- `src/backend/schema.prisma` defines the `MeetingAiResult` table.

## Summary

The backend uses OpenAI's Responses API to generate a structured JSON analysis from the saved meeting transcript.

The analysis includes:

- Meeting title
- Concise summary
- Key points
- Decisions
- Action items
- Questions
- Follow-ups
- Participants

The model is instructed to use only transcript evidence. If a field is unknown, it should return `null` or an empty array instead of guessing.

## When It Runs

### Successful bot run

The normal flow is:

```text
Bot finishes meeting
-> POST /bot-done
-> backend marks job as transcript_saved
-> backend loads transcript segments
-> backend uploads VTT artifact to Supabase Storage
-> backend calls OpenAI if OPENAI_API_KEY is set
-> backend stores JSON result in MeetingAiResult
```

Code path:

```text
src/backend/server.ts
POST /bot-done
createVttArtifact(...)
createMeetingAnalysisIfEnabled(...)
```

### Failed bot run with partial transcript

If the bot fails but a `meetingId` exists and saved transcript segments are available, the backend still attempts to create post-run artifacts:

```text
Bot fails
-> POST /bot-failed
-> backend marks job as failed
-> backend loads transcript segments
-> backend uploads VTT artifact to Supabase Storage if segments exist
-> backend calls OpenAI if OPENAI_API_KEY is set
-> backend stores JSON result in MeetingAiResult
```

If OpenAI fails, the backend logs a warning and still returns the transcript/VTT result. The LLM step is intentionally non-blocking for meeting finalization.

## Environment Variables

```env
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.5
OPENAI_REASONING_EFFORT=low
OPENAI_VERBOSITY=low
OPENAI_TRANSCRIPT_MAX_CHARS=60000
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SECRET_KEY=sb_secret_your-server-secret
SUPABASE_STORAGE_BUCKET=meeting-artifacts
SUPABASE_STORAGE_PUBLIC=0
```

| Variable                      | Required              | Default                     | Purpose                                                    |
| ----------------------------- | --------------------- | --------------------------- | ---------------------------------------------------------- |
| `OPENAI_API_KEY`              | Yes for AI generation | none                        | Enables the OpenAI call. If empty, AI analysis is skipped. |
| `OPENAI_MODEL`                | No                    | `gpt-5.5`                   | Model sent in the Responses API payload.                   |
| `OPENAI_REASONING_EFFORT`     | No                    | `low`                       | Reasoning effort passed to the model.                      |
| `OPENAI_VERBOSITY`            | No                    | `low`                       | Response verbosity passed under `text.verbosity`.          |
| `OPENAI_TRANSCRIPT_MAX_CHARS` | No                    | `60000`                     | Max cleaned transcript characters sent to OpenAI.          |
| `OPENAI_BASE_URL`             | No                    | `https://api.openai.com/v1` | Optional override for compatible API base URLs.            |
| `OPENAI_API_BASE_URL`         | No                    | `https://api.openai.com/v1` | Alternate base URL override.                               |
| `SUPABASE_URL`                | Yes for VTT upload    | none                        | Supabase project URL used by the backend Storage upload.   |
| `SUPABASE_SECRET_KEY`         | Yes for VTT upload    | none                        | Backend-only Supabase secret key for Storage writes.       |
| `SUPABASE_STORAGE_BUCKET`     | Yes for VTT upload    | none                        | Bucket where VTT artifacts are uploaded.                   |
| `SUPABASE_STORAGE_PUBLIC`     | No                    | `0`                         | Stores public URLs when set to `1`; otherwise stores `supabase://bucket/path`. |

## Input Data Source

The LLM does not receive the raw database rows directly. The backend first loads a `MeetingTranscript`:

```ts
type MeetingTranscript = {
  meetingId: string;
  createdAt: Date;
  segments: Segment[];
};

type Segment = {
  start: number;
  end: number;
  text: string;
  speaker: string;
};
```

Example database transcript shape before cleanup:

```json
{
  "meetingId": "ccbf8caf-5371-4bc7-9bd0-79b8fc224f36",
  "createdAt": "2026-06-30T09:30:00.000Z",
  "segments": [
    {
      "start": 0,
      "end": 1,
      "speaker": "Krish",
      "text": "Testing for the vtt."
    },
    {
      "start": 1,
      "end": 2,
      "speaker": "Krish",
      "text": "Testing for the vtt as a local file."
    },
    {
      "start": 4,
      "end": 8,
      "speaker": "Ava",
      "text": "We should send the report by Friday."
    }
  ]
}
```

## Transcript Cleanup

Live captions often create repeated incremental text:

```text
Testing for the vtt.
Testing for the vtt as a local file.
```

Before sending text to OpenAI, `renderCleanTranscript(...)` and `cleanTranscriptSegments(...)`:

- Remove empty text segments.
- Sort segments by start time.
- Normalize whitespace and punctuation for comparison.
- Collapse incremental captions from the same speaker into the longest version.
- Merge exact duplicate consecutive captions.
- Render lines with timestamps and speakers.
- Truncate the final rendered transcript to `OPENAI_TRANSCRIPT_MAX_CHARS`.

The cleaned transcript sent to OpenAI looks like:

```text
[00:00-00:02] Krish: Testing for the vtt as a local file.
[00:04-00:08] Ava: We should send the report by Friday.
```

You can inspect this exact cleaned transcript without calling OpenAI:

```bash
npm run summarize:meeting -- ccbf8caf-5371-4bc7-9bd0-79b8fc224f36 --dry-run
```

## OpenAI Request Payload

The request is sent to:

```text
POST https://api.openai.com/v1/responses
```

The effective payload built by `src/summarize.ts` is:

```json
{
  "model": "gpt-5.5",
  "instructions": "You are a meeting analyst. Use only the transcript content supplied by the user. Do not invent decisions, action item owners, dates, attendees, or follow-ups. Use null for unknown owners and due dates. Use [] when a section has no evidence. Keep the summary concise and useful for someone who missed the meeting.",
  "input": "Meeting ID: ccbf8caf-5371-4bc7-9bd0-79b8fc224f36\nCreated at: 2026-06-30T09:30:00.000Z\n\nTranscript:\n[00:00-00:02] Krish: Testing for the vtt as a local file.\n[00:04-00:08] Ava: We should send the report by Friday.",
  "reasoning": {
    "effort": "low"
  },
  "text": {
    "verbosity": "low",
    "format": {
      "type": "json_schema",
      "name": "meeting_analysis",
      "strict": true,
      "schema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "title": { "type": "string" },
          "summary": { "type": "string" },
          "keyPoints": {
            "type": "array",
            "items": { "type": "string" }
          },
          "decisions": {
            "type": "array",
            "items": { "type": "string" }
          },
          "actionItems": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "task": { "type": "string" },
                "owner": { "type": ["string", "null"] },
                "dueDate": { "type": ["string", "null"] },
                "priority": {
                  "type": "string",
                  "enum": ["low", "medium", "high"]
                }
              },
              "required": ["task", "owner", "dueDate", "priority"]
            }
          },
          "questions": {
            "type": "array",
            "items": { "type": "string" }
          },
          "followUps": {
            "type": "array",
            "items": { "type": "string" }
          },
          "participants": {
            "type": "array",
            "items": { "type": "string" }
          }
        },
        "required": [
          "title",
          "summary",
          "keyPoints",
          "decisions",
          "actionItems",
          "questions",
          "followUps",
          "participants"
        ]
      }
    }
  }
}
```

Notes:

- The `model`, `reasoning.effort`, `text.verbosity`, and transcript length can be controlled by environment variables.
- The schema is strict and does not allow additional fields.
- The prompt explicitly tells the model not to infer missing owners, due dates, decisions, or attendees.
- The OpenAI API key is sent only as an Authorization header, not inside the JSON body.

## LLM Output Contract

The parsed model output is stored as this TypeScript shape:

```ts
type MeetingAnalysis = {
  title: string;
  summary: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: {
    task: string;
    owner: string | null;
    dueDate: string | null;
    priority: "low" | "medium" | "high";
  }[];
  questions: string[];
  followUps: string[];
  participants: string[];
};
```

Example LLM output:

```json
{
  "title": "Report Follow-Up Discussion",
  "summary": "The meeting covered local transcript testing and a follow-up report that should be sent by Friday.",
  "keyPoints": [
    "The transcript/VTT flow was tested with a local file.",
    "A report needs to be sent by Friday."
  ],
  "decisions": [],
  "actionItems": [
    {
      "task": "Send the report",
      "owner": "Ava",
      "dueDate": "Friday",
      "priority": "medium"
    }
  ],
  "questions": [],
  "followUps": ["Confirm whether the report was sent."],
  "participants": ["Krish", "Ava"]
}
```

Field rules:

| Field                    | Type                          | Meaning                                                                     |
| ------------------------ | ----------------------------- | --------------------------------------------------------------------------- |
| `title`                  | `string`                      | Short descriptive title inferred from transcript content.                   |
| `summary`                | `string`                      | Concise summary for someone who missed the meeting.                         |
| `keyPoints`              | `string[]`                    | Important discussion points that are directly supported by transcript text. |
| `decisions`              | `string[]`                    | Confirmed decisions only. If none are explicit, this is `[]`.               |
| `actionItems`            | `object[]`                    | Tasks explicitly mentioned or strongly implied by transcript text.          |
| `actionItems[].task`     | `string`                      | The task to do.                                                             |
| `actionItems[].owner`    | `string \| null`              | Responsible person if clearly known, otherwise `null`.                      |
| `actionItems[].dueDate`  | `string \| null`              | Due date if clearly known, otherwise `null`.                                |
| `actionItems[].priority` | `"low" \| "medium" \| "high"` | Model-assigned priority based on transcript evidence.                       |
| `questions`              | `string[]`                    | Open questions raised in the meeting.                                       |
| `followUps`              | `string[]`                    | Follow-up items that are not concrete action items.                         |
| `participants`           | `string[]`                    | Speaker names found in the transcript.                                      |

## Raw OpenAI Response Handling

OpenAI returns a full Responses API object. The application does not store the full response object right now.

The analyzer extracts text in this order:

1. `response.output_text`, if present.
2. Text from `response.output[].content[].text`.
3. Text from `response.output[].content[].output_text`.

That text should be a JSON string matching the strict `meeting_analysis` schema. The backend parses that string into `MeetingAnalysis` and stores only the parsed object in `MeetingAiResult.outputJson`.

Conceptually:

```json
{
  "id": "resp_...",
  "model": "gpt-5.5",
  "output_text": "{\"title\":\"Report Follow-Up Discussion\",\"summary\":\"...\",\"keyPoints\":[],\"decisions\":[],\"actionItems\":[],\"questions\":[],\"followUps\":[],\"participants\":[]}"
}
```

Becomes:

```json
{
  "title": "Report Follow-Up Discussion",
  "summary": "...",
  "keyPoints": [],
  "decisions": [],
  "actionItems": [],
  "questions": [],
  "followUps": [],
  "participants": []
}
```

## Saved Database Record

The result is upserted into `MeetingAiResult`.

Prisma model:

```prisma
model MeetingAiResult {
  id                String            @id @default(uuid())
  meetingId         String
  meetingTranscript MeetingTranscript @relation(fields: [meetingId], references: [meetingId])
  kind              String
  model             String
  outputJson        Json
  generatedAt       DateTime          @default(now())
  createdAt         DateTime          @default(now())
  updatedAt         DateTime          @updatedAt

  @@unique([meetingId, kind])
  @@index([meetingId])
}
```

The current `kind` is:

```text
meeting_analysis
```

Because of `@@unique([meetingId, kind])`, rerunning analysis for the same meeting updates the existing row instead of creating duplicates.

Example saved row:

```json
{
  "id": "7a5f25f8-6f8f-4d7e-b9cb-6c6e205ce1cb",
  "meetingId": "ccbf8caf-5371-4bc7-9bd0-79b8fc224f36",
  "kind": "meeting_analysis",
  "model": "gpt-5.5",
  "outputJson": {
    "title": "Report Follow-Up Discussion",
    "summary": "The meeting covered local transcript testing and a follow-up report that should be sent by Friday.",
    "keyPoints": [
      "The transcript/VTT flow was tested with a local file.",
      "A report needs to be sent by Friday."
    ],
    "decisions": [],
    "actionItems": [
      {
        "task": "Send the report",
        "owner": "Ava",
        "dueDate": "Friday",
        "priority": "medium"
      }
    ],
    "questions": [],
    "followUps": ["Confirm whether the report was sent."],
    "participants": ["Krish", "Ava"]
  },
  "generatedAt": "2026-06-30T09:45:00.000Z",
  "createdAt": "2026-06-30T09:45:00.000Z",
  "updatedAt": "2026-06-30T09:45:00.000Z"
}
```

Query latest result:

```sql
SELECT "meetingId",
       "kind",
       "generatedAt",
       "model",
       "outputJson"
FROM   "MeetingAiResult"
ORDER  BY "generatedAt" DESC
LIMIT  1;
```

Query one meeting:

```sql
SELECT "meetingId",
       "kind",
       "generatedAt",
       "model",
       "outputJson"
FROM   "MeetingAiResult"
WHERE  "meetingId" = 'ccbf8caf-5371-4bc7-9bd0-79b8fc224f36'
AND    "kind" = 'meeting_analysis';
```

## Backend Callback Response

When analysis is generated successfully, `/bot-done` includes `aiResult` in the response:

```json
{
  "status": "transcript_saved",
  "job": {
    "id": "job-id",
    "meetingUrl": "https://meet.google.com/abc-defg-hij",
    "status": "transcript_saved",
    "meetingId": "ccbf8caf-5371-4bc7-9bd0-79b8fc224f36"
  },
  "transcript": {
    "meetingId": "ccbf8caf-5371-4bc7-9bd0-79b8fc224f36",
    "createdAt": "2026-06-30T09:30:00.000Z",
    "segments": []
  },
  "vttArtifact": {
    "meetingId": "ccbf8caf-5371-4bc7-9bd0-79b8fc224f36",
    "kind": "transcript_vtt",
    "mimeType": "text/vtt",
    "storagePath": "supabase://meeting-artifacts/vtt/ccbf8caf-5371-4bc7-9bd0-79b8fc224f36.vtt"
  },
  "aiResult": {
    "meetingId": "ccbf8caf-5371-4bc7-9bd0-79b8fc224f36",
    "kind": "meeting_analysis",
    "model": "gpt-5.5",
    "outputJson": {
      "title": "Report Follow-Up Discussion",
      "summary": "The meeting covered local transcript testing and a follow-up report that should be sent by Friday.",
      "keyPoints": [],
      "decisions": [],
      "actionItems": [],
      "questions": [],
      "followUps": [],
      "participants": []
    }
  }
}
```

If `OPENAI_API_KEY` is not set or OpenAI fails, `aiResult` is `null`.

## Manual Backfill

Generate analysis for the latest transcript:

```bash
npm run summarize:meeting
```

Generate analysis for a specific meeting:

```bash
npm run summarize:meeting -- ccbf8caf-5371-4bc7-9bd0-79b8fc224f36
```

Preview the cleaned transcript only:

```bash
npm run summarize:meeting -- ccbf8caf-5371-4bc7-9bd0-79b8fc224f36 --dry-run
```

## Setup Checklist

1. Add `OPENAI_API_KEY` to `.env`.
2. Choose the model with `OPENAI_MODEL`, or keep the default `gpt-5.5`.
3. Apply the database migration:

```bash
npx prisma migrate deploy --schema=src/backend/schema.prisma
```

4. Regenerate Prisma client if needed:

```bash
npm run generate
```

5. Build the backend:

```bash
npm run build:backend
```

6. Test on an existing transcript:

```bash
npm run summarize:meeting -- ccbf8caf-5371-4bc7-9bd0-79b8fc224f36
```

## Error Behavior

The backend handles OpenAI analysis as optional post-processing:

- Missing `OPENAI_API_KEY`: logs a skip message and returns `aiResult: null`.
- Empty transcript: throws inside the analyzer, then backend catches and logs a warning.
- OpenAI HTTP error: backend logs a warning and returns `aiResult: null`.
- Invalid or missing model output text: backend logs a warning and returns `aiResult: null`.

The meeting job, transcript, and VTT artifact should still complete even if LLM analysis fails.

## Current Limitations

- The OpenAI call runs synchronously inside `/bot-done` and `/bot-failed`.
- Long transcripts are truncated by character count, not summarized in chunks.
- The current output schema is fixed in `src/summarize.ts`.
- There is no frontend display for `MeetingAiResult` yet.
- The model may still produce imperfect analysis if the transcript is sparse, noisy, or missing speaker context.

## Future Improvements

- Move LLM analysis to a background worker or queue.
- Add chunking for long transcripts.
- Add a frontend view for `MeetingAiResult.outputJson`.
- Add automated tests for transcript cleanup and schema parsing.
- Add prompt/version metadata if multiple analysis prompts are introduced.
- Add cost and latency logging for OpenAI calls.

## OpenAI References

- Responses API: https://platform.openai.com/docs/api-reference/responses
- Structured Outputs: https://platform.openai.com/docs/guides/structured-outputs
- Model guide: https://developers.openai.com/api/docs/guides/latest-model.md
