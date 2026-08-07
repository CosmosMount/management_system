CREATE TYPE "RiskRecordStatus" AS ENUM ('ACTIVE', 'RESOLVED');

CREATE TABLE "RiskRecord" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "taskId" TEXT,
    "content" VARCHAR(2000) NOT NULL,
    "status" "RiskRecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByAccountId" TEXT NOT NULL,
    "createdByPersonId" TEXT,
    "createdByName" VARCHAR(200) NOT NULL,
    "resolvedByAccountId" TEXT,
    "resolvedByPersonId" TEXT,
    "resolvedByName" VARCHAR(200),
    "resolveNote" VARCHAR(500),
    "resolvedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "RiskRecord_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RiskRecord_target_xor_check" CHECK (("projectId" IS NOT NULL) <> ("taskId" IS NOT NULL)),
    CONSTRAINT "RiskRecord_resolution_check" CHECK (
      ("status" = 'ACTIVE' AND "resolvedByAccountId" IS NULL AND "resolvedByPersonId" IS NULL AND "resolvedByName" IS NULL AND "resolveNote" IS NULL AND "resolvedAt" IS NULL)
      OR
      ("status" = 'RESOLVED' AND "resolvedByAccountId" IS NOT NULL AND "resolvedByName" IS NOT NULL AND "resolveNote" IS NOT NULL AND "resolvedAt" IS NOT NULL)
    )
);

CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "taskId" TEXT,
    "authorAccountId" TEXT NOT NULL,
    "authorPersonId" TEXT,
    "authorName" VARCHAR(200) NOT NULL,
    "content" VARCHAR(1000) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedByAccountId" TEXT,
    "deletedByPersonId" TEXT,
    "deletedByName" VARCHAR(200),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Comment_target_xor_check" CHECK (("projectId" IS NOT NULL) <> ("taskId" IS NOT NULL)),
    CONSTRAINT "Comment_deletion_check" CHECK (
      ("deletedAt" IS NULL AND "deletedByAccountId" IS NULL AND "deletedByPersonId" IS NULL AND "deletedByName" IS NULL)
      OR
      ("deletedAt" IS NOT NULL AND "deletedByAccountId" IS NOT NULL AND "deletedByName" IS NOT NULL)
    )
);

CREATE INDEX "RiskRecord_projectId_status_createdAt_id_idx" ON "RiskRecord"("projectId", "status", "createdAt", "id");
CREATE INDEX "RiskRecord_taskId_status_createdAt_id_idx" ON "RiskRecord"("taskId", "status", "createdAt", "id");
CREATE INDEX "RiskRecord_createdByAccountId_idx" ON "RiskRecord"("createdByAccountId");
CREATE INDEX "RiskRecord_createdByPersonId_idx" ON "RiskRecord"("createdByPersonId");
CREATE INDEX "RiskRecord_resolvedByAccountId_idx" ON "RiskRecord"("resolvedByAccountId");
CREATE INDEX "RiskRecord_resolvedByPersonId_idx" ON "RiskRecord"("resolvedByPersonId");
CREATE INDEX "Comment_projectId_deletedAt_createdAt_id_idx" ON "Comment"("projectId", "deletedAt", "createdAt", "id");
CREATE INDEX "Comment_taskId_deletedAt_createdAt_id_idx" ON "Comment"("taskId", "deletedAt", "createdAt", "id");
CREATE INDEX "Comment_authorAccountId_idx" ON "Comment"("authorAccountId");
CREATE INDEX "Comment_authorPersonId_idx" ON "Comment"("authorPersonId");
CREATE INDEX "Comment_deletedByAccountId_idx" ON "Comment"("deletedByAccountId");
CREATE INDEX "Comment_deletedByPersonId_idx" ON "Comment"("deletedByPersonId");

ALTER TABLE "RiskRecord" ADD CONSTRAINT "RiskRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RiskRecord" ADD CONSTRAINT "RiskRecord_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RiskRecord" ADD CONSTRAINT "RiskRecord_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RiskRecord" ADD CONSTRAINT "RiskRecord_createdByPersonId_fkey" FOREIGN KEY ("createdByPersonId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RiskRecord" ADD CONSTRAINT "RiskRecord_resolvedByAccountId_fkey" FOREIGN KEY ("resolvedByAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RiskRecord" ADD CONSTRAINT "RiskRecord_resolvedByPersonId_fkey" FOREIGN KEY ("resolvedByPersonId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorAccountId_fkey" FOREIGN KEY ("authorAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorPersonId_fkey" FOREIGN KEY ("authorPersonId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_deletedByAccountId_fkey" FOREIGN KEY ("deletedByAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_deletedByPersonId_fkey" FOREIGN KEY ("deletedByPersonId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
