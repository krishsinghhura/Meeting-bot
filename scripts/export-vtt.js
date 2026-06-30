/* scripts/export-vtt.js
 * Uploads a WebVTT transcript for one meeting and stores artifact details in
 * the database.
 */

require("dotenv").config();
const path = require("path");
require("ts-node").register({
  project: path.resolve(__dirname, "../src/backend/tsconfig.json"),
  transpileOnly: true,
});

const { PrismaClient } = require("@prisma/client");
const { createVttArtifact } = require("../src/backend/vtt");

const prisma = new PrismaClient();

async function latestTranscriptMeetingId() {
  const transcript = await prisma.meetingTranscript.findFirst({
    orderBy: { createdAt: "desc" },
    select: { meetingId: true },
  });
  return transcript?.meetingId || null;
}

async function main() {
  const meetingId = process.argv[2] || (await latestTranscriptMeetingId());
  if (!meetingId) {
    throw new Error("No meetingId passed and no transcript rows exist.");
  }

  const transcript = await prisma.meetingTranscript.findUniqueOrThrow({
    where: { meetingId },
    include: { segments: true },
  });

  const artifact = await createVttArtifact({
    meetingId: transcript.meetingId,
    createdAt: transcript.createdAt,
    segments: transcript.segments,
  });

  console.log(JSON.stringify(artifact, null, 2));
}

main()
  .catch((err) => {
    console.error("export-vtt failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
