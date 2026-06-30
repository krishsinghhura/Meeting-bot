import "./loadEnv";
import express from "express";
import cors from "cors";
import {
  createMeetingJob,
  getMeetingJob,
  getTranscript,
  saveMeetingAiResult,
  updateMeetingStatus,
} from "../storage";
import { launchBotContainer } from "./launchBot";
import { describeDatabaseUrl } from "./env";
import { createLocalVttArtifact } from "./vtt";
import {
  analyzeMeetingTranscript,
  getOpenAiModel,
  isMeetingAnalysisEnabled,
} from "../summarize";
import type { MeetingTranscript } from "../models";

const app = express();
// turn on CORS for frontend at localhost:5173
app.use(
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  }),
);

// parse JSON requests
app.use(express.json());

// simple logging for requests
app.use((req, _, next) => {
  console.log(`[${req.method}] ${req.url}`);
  next();
});

function detectMeetingProvider(url: string) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "meet.google.com") return "google_meet";
    if (hostname === "teams.microsoft.com" || hostname === "teams.live.com") {
      return "microsoft_teams";
    }
  } catch {
    return null;
  }

  return null;
}

async function createMeetingAnalysisIfEnabled(transcript: MeetingTranscript) {
  if (!isMeetingAnalysisEnabled()) {
    console.log(
      `Skipping meeting analysis for ${transcript.meetingId}: OPENAI_API_KEY is not set`,
    );
    return null;
  }

  try {
    console.log(
      `Generating meeting analysis for ${transcript.meetingId} with ${getOpenAiModel()}`,
    );
    const analysis = await analyzeMeetingTranscript(transcript);
    return await saveMeetingAiResult(analysis);
  } catch (err) {
    console.warn(
      `Could not generate meeting analysis for ${transcript.meetingId}:`,
      err,
    );
    return null;
  }
}

async function finalizeTranscriptArtifacts(transcript: MeetingTranscript) {
  const vttArtifact = await createLocalVttArtifact(transcript);

  // Keep AI analysis after the VTT write/storage record succeeds.
  const aiResult = await createMeetingAnalysisIfEnabled(transcript);

  return { vttArtifact, aiResult };
}

// endpoint to start bot with given url
app.post("/submit-link", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "missing_url" });
  const provider = detectMeetingProvider(url);
  if (!provider)
    return res.status(400).json({ error: "unsupported_meeting_link" });

  try {
    const job = await createMeetingJob(url);
    const launch = await launchBotContainer(url, job.id, provider);

    res.status(202).json({
      status: "started",
      message: "Bot started for meeting",
      jobId: job.id,
      meetingUrl: url,
      provider,
      containerName: launch.containerName,
      authMode: launch.authStateMounted ? "auth_json" : "guest",
      authStateMounted: launch.authStateMounted,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed_to_launch_bot" });
  }
});

// endpoint to fetch transcript for meeting
app.get("/meeting-summary/:id", async (req, res) => {
  const meetingId = req.params.id;
  const transcript = await getTranscript(meetingId);

  if (!transcript) return res.status(404).send("Transcript not ready");

  console.log(`Transcript requested for meeting ${meetingId}`);
  console.dir(transcript, { depth: null });
  res.json({ transcript });
});

// endpoint when bot signals it's done
app.post("/bot-done", async (req, res) => {
  const { jobId, meetingId } = req.body;
  if (!jobId || !meetingId) return res.status(400).send("Missing fields");

  try {
    console.log(
      `Bot reported completion for job ${jobId}, meeting ${meetingId}`,
    );

    // job saved its transcript
    await updateMeetingStatus(jobId, "transcript_saved", meetingId);

    const job = await getMeetingJob(jobId);
    const transcript = await getTranscript(meetingId);
    if (!transcript) {
      console.warn(`Transcript not found for meeting ${meetingId}`);
      return res.status(202).send("Transcript not found yet");
    }
    const { vttArtifact, aiResult } =
      await finalizeTranscriptArtifacts(transcript);

    console.log("Bot completion payload:");
    console.dir(req.body, { depth: null });
    console.log("Meeting job:");
    console.dir(job, { depth: null });
    console.log("Transcript:");
    console.dir(transcript, { depth: null });
    console.log("VTT artifact:");
    console.dir(vttArtifact, { depth: null });
    if (aiResult) {
      console.log("Meeting AI result:");
      console.dir(aiResult, { depth: null });
    }

    res.json({
      status: "transcript_saved",
      job,
      transcript,
      vttArtifact,
      aiResult,
    });
  } catch (err) {
    console.error(`Error processing job ${jobId}:`, err);
    res.status(500).send("Failed to finalize job");
  }
});

// endpoint when bot exits before completing a transcript
app.post("/bot-failed", async (req, res) => {
  const { jobId, meetingId, error } = req.body;
  if (!jobId) return res.status(400).send("Missing jobId");

  try {
    await updateMeetingStatus(jobId, "failed", meetingId);
    const job = await getMeetingJob(jobId);
    let vttArtifact: Awaited<
      ReturnType<typeof createLocalVttArtifact>
    > | null = null;
    let aiResult: Awaited<
      ReturnType<typeof createMeetingAnalysisIfEnabled>
    > | null = null;

    if (meetingId) {
      try {
        const transcript = await getTranscript(meetingId);
        if (transcript.segments.length > 0) {
          const finalization = await finalizeTranscriptArtifacts(transcript);
          vttArtifact = finalization.vttArtifact;
          aiResult = finalization.aiResult;
        }
      } catch (artifactErr) {
        console.warn(
          `Could not create post-run artifacts for failed meeting ${meetingId}:`,
          artifactErr,
        );
      }
    }

    console.log("Bot failure payload:");
    console.dir(req.body, { depth: null });
    console.log("Meeting job:");
    console.dir(job, { depth: null });
    if (vttArtifact) {
      console.log("VTT artifact:");
      console.dir(vttArtifact, { depth: null });
    }
    if (aiResult) {
      console.log("Meeting AI result:");
      console.dir(aiResult, { depth: null });
    }

    res.json({
      status: "failed",
      job,
      error,
      vttArtifact,
      aiResult,
    });
  } catch (err) {
    console.error(`Error marking job ${jobId} failed:`, err);
    res.status(500).send("Failed to mark job failed");
  }
});

const port = Number(process.env.PORT ?? 3001);

app.listen(port, "0.0.0.0", () => {
  console.log(`Backend listening on port ${port}`);
  console.log(`Backend database: ${describeDatabaseUrl()}`);
});
