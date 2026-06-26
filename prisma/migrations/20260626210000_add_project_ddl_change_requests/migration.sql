-- CreateEnum
CREATE TYPE "ProjectDdlChangeRequestType" AS ENUM ('CASCADE_EXTENSION', 'SINGLE_STAGE_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "ProjectDdlChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "ProjectMilestone" ADD COLUMN "extensionCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ProjectMilestone" ADD COLUMN "benignExtensionCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ProjectDdlChangeRequest" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "type" "ProjectDdlChangeRequestType" NOT NULL,
    "status" "ProjectDdlChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requesterOpenId" TEXT NOT NULL,
    "requesterName" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "oldDueAt" TIMESTAMP(3),
    "newDueAt" TIMESTAMP(3),
    "durationDays" INTEGER,
    "requestedIsBenign" BOOLEAN,
    "finalIsBenign" BOOLEAN,
    "reviewerOpenId" TEXT NOT NULL DEFAULT '',
    "reviewerName" TEXT NOT NULL DEFAULT '',
    "reviewComment" TEXT NOT NULL DEFAULT '',
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectDdlChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectDdlChangeRequest_projectId_status_idx" ON "ProjectDdlChangeRequest"("projectId", "status");

-- CreateIndex
CREATE INDEX "ProjectDdlChangeRequest_stageId_status_idx" ON "ProjectDdlChangeRequest"("stageId", "status");

-- CreateIndex
CREATE INDEX "ProjectDdlChangeRequest_requesterOpenId_idx" ON "ProjectDdlChangeRequest"("requesterOpenId");

-- AddForeignKey
ALTER TABLE "ProjectDdlChangeRequest" ADD CONSTRAINT "ProjectDdlChangeRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDdlChangeRequest" ADD CONSTRAINT "ProjectDdlChangeRequest_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "ProjectMilestone"("id") ON DELETE CASCADE ON UPDATE CASCADE;
