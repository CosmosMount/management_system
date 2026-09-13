BEGIN;

CREATE TABLE "MeetingRecord" (
    "id" TEXT NOT NULL,
    "topic" VARCHAR(200) NOT NULL,
    "rangeStart" TIMESTAMPTZ(6) NOT NULL,
    "rangeEnd" TIMESTAMPTZ(6) NOT NULL,
    "minutes" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "MeetingRecord_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MeetingRecord_valid_range" CHECK ("rangeEnd" > "rangeStart" AND "rangeEnd" - "rangeStart" <= INTERVAL '366 days'),
    CONSTRAINT "MeetingRecord_valid_version" CHECK ("version" >= 0)
);
CREATE TABLE "MeetingRecordParticipant" (
    "meetingId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    CONSTRAINT "MeetingRecordParticipant_pkey" PRIMARY KEY ("meetingId", "personId")
);
CREATE INDEX "MeetingRecord_createdAt_id_idx" ON "MeetingRecord"("createdAt", "id");
CREATE INDEX "MeetingRecord_createdByAccountId_idx" ON "MeetingRecord"("createdByAccountId");
CREATE INDEX "MeetingRecordParticipant_personId_idx" ON "MeetingRecordParticipant"("personId");
ALTER TABLE "MeetingRecord" ADD CONSTRAINT "MeetingRecord_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MeetingRecordParticipant" ADD CONSTRAINT "MeetingRecordParticipant_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "MeetingRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MeetingRecordParticipant" ADD CONSTRAINT "MeetingRecordParticipant_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
