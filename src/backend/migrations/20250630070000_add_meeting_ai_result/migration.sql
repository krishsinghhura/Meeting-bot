-- CreateTable
CREATE TABLE "MeetingAiResult" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "outputJson" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingAiResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MeetingAiResult_meetingId_kind_key" ON "MeetingAiResult"("meetingId", "kind");

-- CreateIndex
CREATE INDEX "MeetingAiResult_meetingId_idx" ON "MeetingAiResult"("meetingId");

-- AddForeignKey
ALTER TABLE "MeetingAiResult" ADD CONSTRAINT "MeetingAiResult_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "MeetingTranscript"("meetingId") ON DELETE RESTRICT ON UPDATE CASCADE;
