-- CreateEnum
CREATE TYPE "TaskDdlChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TaskRiskStatus" AS ENUM ('ACTIVE', 'RESOLVED');

-- CreateEnum
CREATE TYPE "TaskRiskSource" AS ENUM ('MANUAL', 'WEEKLY');

-- CreateTable
CREATE TABLE "TaskTechGroup" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "techGroup" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskTechGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskDdlChangeRequest" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "requesterOpenId" TEXT NOT NULL,
    "requesterName" TEXT NOT NULL,
    "oldDueAt" TIMESTAMP(3) NOT NULL,
    "newDueAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "TaskDdlChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "pendingKey" TEXT NOT NULL DEFAULT '',
    "reviewerOpenId" TEXT NOT NULL DEFAULT '',
    "reviewerName" TEXT NOT NULL DEFAULT '',
    "reviewComment" TEXT NOT NULL DEFAULT '',
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskDdlChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskRiskRecord" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" "TaskRiskSource" NOT NULL DEFAULT 'MANUAL',
    "status" "TaskRiskStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByOpenId" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "resolvedByOpenId" TEXT NOT NULL DEFAULT '',
    "resolvedByName" TEXT NOT NULL DEFAULT '',
    "resolveNote" TEXT NOT NULL DEFAULT '',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskRiskRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskTechGroup_techGroup_idx" ON "TaskTechGroup"("techGroup");

-- CreateIndex
CREATE UNIQUE INDEX "TaskTechGroup_taskId_techGroup_key" ON "TaskTechGroup"("taskId", "techGroup");

-- CreateIndex
CREATE INDEX "TaskDdlChangeRequest_taskId_status_idx" ON "TaskDdlChangeRequest"("taskId", "status");

-- CreateIndex
CREATE INDEX "TaskDdlChangeRequest_requesterOpenId_idx" ON "TaskDdlChangeRequest"("requesterOpenId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskDdlChangeRequest_taskId_pendingKey_key" ON "TaskDdlChangeRequest"("taskId", "pendingKey");

-- CreateIndex
CREATE INDEX "TaskRiskRecord_taskId_status_idx" ON "TaskRiskRecord"("taskId", "status");

-- CreateIndex
CREATE INDEX "TaskRiskRecord_createdByOpenId_idx" ON "TaskRiskRecord"("createdByOpenId");

-- AddForeignKey
ALTER TABLE "TaskTechGroup" ADD CONSTRAINT "TaskTechGroup_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDdlChangeRequest" ADD CONSTRAINT "TaskDdlChangeRequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRiskRecord" ADD CONSTRAINT "TaskRiskRecord_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill existing tasks with their project-level tech group so legacy data remains visible.
INSERT INTO "TaskTechGroup" ("id", "taskId", "techGroup", "sortOrder", "createdAt")
SELECT
  'task-tech-' || md5(random()::text || clock_timestamp()::text || "id"),
  "id",
  CASE WHEN COALESCE("techGroup", '') = '' THEN '通用' ELSE "techGroup" END,
  0,
  CURRENT_TIMESTAMP
FROM "Task"
ON CONFLICT ("taskId", "techGroup") DO NOTHING;

-- Backfill active task-level risk notes into the structured risk history.
INSERT INTO "TaskRiskRecord" (
  "id",
  "taskId",
  "content",
  "source",
  "status",
  "createdByOpenId",
  "createdByName",
  "createdAt",
  "updatedAt"
)
SELECT
  'task-risk-' || md5(random()::text || clock_timestamp()::text || "id"),
  "id",
  "riskNote",
  'MANUAL'::"TaskRiskSource",
  'ACTIVE'::"TaskRiskStatus",
  '',
  '历史风险',
  COALESCE("riskUpdatedAt", "updatedAt", CURRENT_TIMESTAMP),
  CURRENT_TIMESTAMP
FROM "Task"
WHERE COALESCE(BTRIM("riskNote"), '') <> '';

-- Keep legacy weekly risk text searchable in the new history without making it active.
INSERT INTO "TaskRiskRecord" (
  "id",
  "taskId",
  "content",
  "source",
  "status",
  "createdByOpenId",
  "createdByName",
  "resolvedByName",
  "resolveNote",
  "resolvedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  'weekly-risk-' || md5(random()::text || clock_timestamp()::text || "id"),
  "taskId",
  "risks",
  'WEEKLY'::"TaskRiskSource",
  'RESOLVED'::"TaskRiskStatus",
  COALESCE("submittedBy", ''),
  COALESCE(NULLIF("submitterName", ''), '历史周报'),
  '系统导入',
  '历史周报风险记录',
  "submittedAt",
  "submittedAt",
  CURRENT_TIMESTAMP
FROM "WeeklyReport"
WHERE COALESCE(BTRIM("risks"), '') <> '';
