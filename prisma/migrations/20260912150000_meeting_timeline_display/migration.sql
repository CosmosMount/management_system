BEGIN;

ALTER TABLE "MeetingRecord"
ADD COLUMN "timelineDisplay" JSONB NOT NULL DEFAULT '{"projectIds":[],"taskIds":[]}';

COMMIT;
