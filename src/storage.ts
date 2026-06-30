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
export async function createMeetingJob(meetingUrl: string) {
  return await prisma.meetingJob.create({
    data: { meetingUrl },
  });
}

// fetch meeting job with ID
export async function getMeetingJob(id: string) {
  return await prisma.meetingJob.findUnique({
    where: { id },
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
  return await prisma.meetingJob.update({
    where: { id },
    data: {
      status,
      meetingId,
    },
  });
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
