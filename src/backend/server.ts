import "./loadEnv";
import express from "express";
import cors from "cors";
import {
  createMeetingJob,
  getMeetingJob,
  getMeetingResultsForJob,
  getTranscript,
  getUserAnalytics,
  getUserMeetingJobByMeetingId,
  listUserMeetingJobs,
  saveMeetingAiResult,
  updateMeetingStatus,
} from "../storage";
import { launchBotContainer } from "./launchBot";
import { describeDatabaseUrl } from "./env";
import { createVttArtifact } from "./vtt";
import {
  analyzeMeetingTranscript,
  getOpenAiModel,
  isMeetingAnalysisEnabled,
  renderCleanTranscript,
} from "../summarize";
import type { MeetingTranscript } from "../models";
import {
  authenticateUser,
  clearSession,
  createSessionForUser,
  getAuthenticatedUser,
  registerUser,
  validateEmail,
  validatePassword,
  type AuthenticatedUser,
} from "./auth";

const app = express();
// turn on CORS for frontend at localhost:5173
app.use(
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    credentials: true,
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

async function requireUser(
  req: express.Request,
  res: express.Response,
): Promise<AuthenticatedUser | null> {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }
  return user;
}

async function createMeetingAnalysisIfEnabled(transcript: MeetingTranscript) {
  if (!isMeetingAnalysisEnabled()) {
    console.log(
      `Skipping meeting analysis for ${transcript.meetingId}: OPENAI_API_KEY is not set`,
    );
    return null;
  }

  const transcriptLength = renderCleanTranscript(transcript).trim().length;
  if (transcriptLength === 0) {
    console.log(
      `Skipping meeting analysis for ${transcript.meetingId}: transcript is empty`,
    );
    return null;
  }

  try {
    console.log(
      `Generating meeting analysis for ${transcript.meetingId} with ${getOpenAiModel()} (${transcriptLength} transcript chars)`,
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
  const vttArtifact = await createVttArtifact(transcript);

  // Keep AI analysis after the VTT write/storage record succeeds.
  const aiResult = await createMeetingAnalysisIfEnabled(transcript);

  return { vttArtifact, aiResult };
}

app.post("/auth/register", async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "missing_fields" });
  }
  if (!validateEmail(email.trim().toLowerCase())) {
    return res.status(400).json({ error: "invalid_email" });
  }
  if (!validatePassword(password)) {
    return res.status(400).json({ error: "weak_password" });
  }

  try {
    const user = await registerUser(email, password);
    await createSessionForUser(res, user.id);
    res.status(201).json({ user });
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      err.code === "P2002"
    ) {
      return res.status(409).json({ error: "email_already_registered" });
    }
    console.error("Registration failed:", err);
    res.status(500).json({ error: "registration_failed" });
  }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "missing_fields" });
  }

  try {
    const user = await authenticateUser(email, password);
    if (!user) {
      return res.status(401).json({ error: "invalid_credentials" });
    }
    await createSessionForUser(res, user.id);
    res.json({ user });
  } catch (err) {
    console.error("Login failed:", err);
    res.status(500).json({ error: "login_failed" });
  }
});

app.post("/auth/logout", async (req, res) => {
  await clearSession(req, res);
  res.json({ ok: true });
});

app.get("/auth/me", async (req, res) => {
  const user = await getAuthenticatedUser(req);
  res.json({ user });
});

// endpoint to start bot with given url
app.post("/submit-link", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "missing_url" });
  const provider = detectMeetingProvider(url);
  if (!provider)
    return res.status(400).json({ error: "unsupported_meeting_link" });

  try {
    const job = await createMeetingJob(url, user.id);
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

app.get("/jobs", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const jobs = await listUserMeetingJobs(user.id);
  res.json({ jobs });
});

app.get("/analytics", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const analytics = await getUserAnalytics(user.id);
  res.json({ analytics });
});

app.get("/jobs/:id", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const results = await getMeetingResultsForJob(user.id, req.params.id);
  if (!results) return res.status(404).json({ error: "job_not_found" });

  res.json(results);
});

// endpoint to fetch transcript for meeting
app.get("/meeting-summary/:id", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const meetingId = req.params.id;
  const job = await getUserMeetingJobByMeetingId(user.id, meetingId);
  if (!job) return res.status(404).send("Transcript not ready");

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
    let vttArtifact: Awaited<ReturnType<typeof createVttArtifact>> | null =
      null;
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
