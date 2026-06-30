-- CreateTable
CREATE TABLE "MeetingArtifact" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "segmentCount" INTEGER NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MeetingArtifact_meetingId_kind_key" ON "MeetingArtifact"("meetingId", "kind");

-- CreateIndex
CREATE INDEX "MeetingArtifact_meetingId_idx" ON "MeetingArtifact"("meetingId");

-- AddForeignKey
ALTER TABLE "MeetingArtifact" ADD CONSTRAINT "MeetingArtifact_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "MeetingTranscript"("meetingId") ON DELETE RESTRICT ON UPDATE CASCADE;
