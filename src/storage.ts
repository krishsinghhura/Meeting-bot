import { PrismaClient } from "@prisma/client";
import {
  MeetingAiResultInput,
  MeetingSummaryInput,
  MeetingTranscript,
  Segment,
} from "./models";

// init prisma client to access db
const prisma = new PrismaClient();

// create job record for mtg
export async function createMeetingJob(meetingUrl: string, userId?: string) {
  return await prisma.meetingJob.create({
    data: { meetingUrl, userId },
  });
}

// fetch meeting job with ID
export async function getMeetingJob(id: string) {
  return await prisma.meetingJob.findUnique({
    where: { id },
  });
}

export async function getUserMeetingJob(userId: string, id: string) {
  return await prisma.meetingJob.findFirst({
    where: { id, userId },
  });
}

export async function getUserMeetingJobByMeetingId(
  userId: string,
  meetingId: string,
) {
  return await prisma.meetingJob.findFirst({
    where: { meetingId, userId },
  });
}

export async function listUserMeetingJobs(userId: string) {
  return await prisma.meetingJob.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export async function getMeetingResultsForJob(userId: string, jobId: string) {
  const job = await prisma.meetingJob.findFirst({
    where: { id: jobId, userId },
  });
  if (!job) return null;

  if (!job.meetingId) {
    return {
      job,
      transcript: null,
      artifacts: [],
      aiResults: [],
    };
  }

  const transcript = await prisma.meetingTranscript.findUnique({
    where: { meetingId: job.meetingId },
    include: {
      segments: {
        orderBy: { start: "asc" },
      },
      artifacts: true,
      aiResults: true,
    },
  });

  return {
    job,
    transcript: transcript
      ? {
          meetingId: transcript.meetingId,
          createdAt: transcript.createdAt,
          segments: transcript.segments,
        }
      : null,
    artifacts: transcript?.artifacts || [],
    aiResults: transcript?.aiResults || [],
  };
}

export async function getUserAnalytics(userId: string) {
  const jobs = await prisma.meetingJob.findMany({
    where: { userId },
    select: {
      id: true,
      status: true,
      meetingId: true,
    },
  });
  const meetingIds = jobs
    .map((job) => job.meetingId)
    .filter((meetingId): meetingId is string => Boolean(meetingId));

  if (meetingIds.length === 0) {
    return emptyAnalytics(jobs.length);
  }

  const transcripts = await prisma.meetingTranscript.findMany({
    where: {
      meetingId: { in: meetingIds },
    },
    include: {
      segments: {
        orderBy: { start: "asc" },
      },
      aiResults: {
        where: { kind: "meeting_analysis" },
      },
    },
  });

  let minutesCaptured = 0;
  let aiCreditsUsed = 0;
  let actionItemCount = 0;
  const speakerSeconds = new Map<string, number>();

  for (const transcript of transcripts) {
    const segments = transcript.segments.filter((segment) =>
      segment.text.trim(),
    );
    const transcriptStart = Math.min(
      ...segments.map((segment) => Math.max(0, segment.start)),
    );
    const transcriptEnd = Math.max(
      ...segments.map((segment) => Math.max(segment.start, segment.end)),
    );

    if (
      segments.length > 0 &&
      Number.isFinite(transcriptStart) &&
      Number.isFinite(transcriptEnd)
    ) {
      minutesCaptured += Math.max(0, transcriptEnd - transcriptStart) / 60;
    }

    for (const segment of segments) {
      const speaker = segment.speaker.trim() || "Unknown Speaker";
      const seconds = Math.max(0, segment.end - segment.start);
      speakerSeconds.set(speaker, (speakerSeconds.get(speaker) || 0) + seconds);
    }

    for (const result of transcript.aiResults) {
      aiCreditsUsed += 1;
      actionItemCount += countActionItems(result.outputJson);
    }
  }

  return {
    meetingCount: jobs.length,
    completedMeetingCount: jobs.filter((job) => job.status === "transcript_saved")
      .length,
    minutesCaptured: Math.round(minutesCaptured),
    aiCreditsUsed,
    actionItemCount,
    speakerParticipation: [...speakerSeconds.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([speaker, seconds]) => ({
        speaker,
        seconds: Math.round(seconds),
        minutes: Math.round((seconds / 60) * 10) / 10,
      })),
  };
}

function emptyAnalytics(meetingCount = 0) {
  return {
    meetingCount,
    completedMeetingCount: 0,
    minutesCaptured: 0,
    aiCreditsUsed: 0,
    actionItemCount: 0,
    speakerParticipation: [],
  };
}

function countActionItems(outputJson: unknown) {
  if (!outputJson || typeof outputJson !== "object") return 0;
  const analysis = outputJson as { actionItems?: unknown };
  return Array.isArray(analysis.actionItems) ? analysis.actionItems.length : 0;
}

export async function createUser(email: string, passwordHash: string) {
  return await prisma.user.create({
    data: { email, passwordHash },
    select: {
      id: true,
      email: true,
      createdAt: true,
    },
  });
}

export async function findUserByEmail(email: string) {
  return await prisma.user.findUnique({
    where: { email },
  });
}

export async function createUserSession(
  userId: string,
  tokenHash: string,
  expiresAt: Date,
) {
  return await prisma.userSession.create({
    data: { userId, tokenHash, expiresAt },
  });
}

export async function findUserBySessionTokenHash(tokenHash: string) {
  return await prisma.userSession.findUnique({
    where: { tokenHash },
    include: {
      user: {
        select: {
          id: true,
          email: true,
        },
      },
    },
  });
}

export async function deleteUserSession(tokenHash: string) {
  await prisma.userSession.deleteMany({
    where: { tokenHash },
  });
}

// save batch of segments
export async function saveTranscriptBatch(
  meetingId: string,
  createdAt: Date,
  batch: Segment[],
  force = false,
) {
  // if batch is empty, don't save unless forced
  if (batch.length === 0 && !force) return;
  console.log("[FLUSH] saving", batch.length, "segments");

  try {
    // make sure transcript exists
    await prisma.meetingTranscript.upsert({
      where: { meetingId },
      update: { createdAt },
      create: { meetingId, createdAt },
    });
    // add segments individually to allow for updates
    for (const seg of batch) {
      await prisma.segment.upsert({
        where: {
          meetingId_start: {
            meetingId,
            start: seg.start,
          },
        },
        update: {
          end: seg.end,
          text: seg.text,
          speaker: seg.speaker,
        },
        create: {
          meetingId,
          start: seg.start,
          end: seg.end,
          text: seg.text,
          speaker: seg.speaker,
        },
      });
    }

    console.log("[FLUSH] OK");
  } catch (err) {
    console.error("[FLUSH] FAILED", err);
  }
}

export async function getTranscript(
  meetingId: string,
): Promise<MeetingTranscript> {
  console.log(`meeting id is ${meetingId}`);
  const transcript = await prisma.meetingTranscript.findUniqueOrThrow({
    where: { meetingId },
    include: {
      segments: true,
    },
  });
  console.dir(transcript);
  return {
    meetingId: transcript.meetingId,
    createdAt: transcript.createdAt,
    segments: transcript.segments,
  };
}

export async function saveMeetingArtifact(input: {
  meetingId: string;
  kind: string;
  mimeType: string;
  storagePath: string;
  fileSizeBytes: number;
  segmentCount: number;
  generatedAt: Date;
}) {
  return await prisma.meetingArtifact.upsert({
    where: {
      meetingId_kind: {
        meetingId: input.meetingId,
        kind: input.kind,
      },
    },
    update: {
      mimeType: input.mimeType,
      storagePath: input.storagePath,
      fileSizeBytes: input.fileSizeBytes,
      segmentCount: input.segmentCount,
      generatedAt: input.generatedAt,
    },
    create: input,
  });
}

export async function saveMeetingAiResult(input: MeetingAiResultInput) {
  return await prisma.meetingAiResult.upsert({
    where: {
      meetingId_kind: {
        meetingId: input.meetingId,
        kind: input.kind,
      },
    },
    update: {
      model: input.model,
      outputJson: input.outputJson,
      generatedAt: input.generatedAt,
    },
    create: input,
  });
}

// update status of job (summarized, transcript_saved, etc)
export async function updateMeetingStatus(
  id: string,
  status: string,
  meetingId?: string,
) {
  return await withPrismaRetry(() =>
    prisma.meetingJob.update({
      where: { id },
      data: {
        status,
        meetingId,
      },
    }),
  );
}

async function withPrismaRetry<T>(operation: () => Promise<T>, attempts = 3) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const code =
        err && typeof err === "object" && "code" in err
          ? String(err.code)
          : "";

      if (code !== "P1001" || attempt === attempts) {
        throw err;
      }

      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }

  throw lastError;
}

// save summary of mtg
export async function saveSummary(summary: MeetingSummaryInput) {
  await prisma.meetingSummary.create({
    data: {
      meetingId: summary.meetingId,
      generatedAt: summary.generatedAt,
      summaryText: summary.summaryText,
      model: summary.model,
    },
  });
}
