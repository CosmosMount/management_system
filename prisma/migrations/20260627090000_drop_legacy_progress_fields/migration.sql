ALTER TABLE "Task" DROP COLUMN IF EXISTS "category";

DROP TYPE IF EXISTS "TaskCategory";

ALTER TABLE "WeeklyReport" DROP COLUMN IF EXISTS "risks";

ALTER TABLE "ApprovalRecord" DROP COLUMN IF EXISTS "docViewVerified";
