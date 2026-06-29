import express from "express";
import cors from "cors";
import {
  createMeetingJob,
  getMeetingJob,
  getTranscript,
  updateMeetingStatus,
} from "../storage";
import { launchBotContainer } from "./launchBot";

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

function validateMeetLink(url: string) {
  const prefix = /^https:\/\/meet\.google\.com/;
  return prefix.test(url);
}

// endpoint to start bot with given url
app.post("/submit-link", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).send(`Missing the URL`);
  if (!validateMeetLink(url)) return res.status(400).send(`Invalid link`);

  try {
    const job = await createMeetingJob(url);
    await launchBotContainer(url, job.id);

    res.send(`Bot started for meeting`);
  } catch (err) {
    console.error(err);
    res.status(500).send(`Failed to launch bot`);
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

    console.log("Bot completion payload:");
    console.dir(req.body, { depth: null });
    console.log("Meeting job:");
    console.dir(job, { depth: null });
    console.log("Transcript:");
    console.dir(transcript, { depth: null });

    res.json({
      status: "transcript_saved",
      job,
      transcript,
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

    console.log("Bot failure payload:");
    console.dir(req.body, { depth: null });
    console.log("Meeting job:");
    console.dir(job, { depth: null });

    res.json({
      status: "failed",
      job,
      error,
    });
  } catch (err) {
    console.error(`Error marking job ${jobId} failed:`, err);
    res.status(500).send("Failed to mark job failed");
  }
});

// start server on port 3000
app.listen(3001, "0.0.0.0", () => {
  console.log("Backend listening on port 3001");
});
