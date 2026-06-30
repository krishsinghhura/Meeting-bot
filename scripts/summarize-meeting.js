/* scripts/summarize-meeting.js
 * Generates a structured OpenAI analysis for one saved meeting transcript.
 */

require("dotenv").config();
const path = require("path");
require("ts-node").register({
  project: path.resolve(__dirname, "../src/backend/tsconfig.json"),
  transpileOnly: true,
});

const { PrismaClient } = require("@prisma/client");
const {
  analyzeMeetingTranscript,
  renderCleanTranscript,
} = require("../src/summarize");
const { saveMeetingAiResult } = require("../src/storage");

const prisma = new PrismaClient();

async function latestTranscriptMeetingId() {
  const transcript = await prisma.meetingTranscript.findFirst({
    orderBy: { createdAt: "desc" },
    select: { meetingId: true },
  });
  return transcript?.meetingId || null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const meetingId =
    process.argv.find(
      (arg) =>
        !arg.startsWith("--") &&
        arg !== process.argv[0] &&
        arg !== process.argv[1],
    ) || (await latestTranscriptMeetingId());

  if (!meetingId) {
    throw new Error("No meetingId passed and no transcript rows exist.");
  }

  const transcript = await prisma.meetingTranscript.findUniqueOrThrow({
    where: { meetingId },
    include: { segments: true },
  });

  const input = {
    meetingId: transcript.meetingId,
    createdAt: transcript.createdAt,
    segments: transcript.segments,
  };

  if (dryRun) {
    console.log(renderCleanTranscript(input));
    return;
  }

  const analysis = await analyzeMeetingTranscript(input);
  const saved = await saveMeetingAiResult(analysis);
  console.log(JSON.stringify(saved, null, 2));
}

main()
  .catch((err) => {
    console.error(
      "summarize-meeting failed:",
      err instanceof Error ? err.message : err,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
