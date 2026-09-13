ALTER TYPE "ProjectManagementReminderKind" ADD VALUE 'ADMIN_GLOBAL_SUMMARY';
CREATE TABLE "AdminGlobalSummaryRun" (
  "id" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "actorAccountId" TEXT,
  "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMPTZ(6),
  "markdown" TEXT NOT NULL DEFAULT '',
  "recipientCount" INTEGER NOT NULL DEFAULT 0,
  "errorMessage" TEXT,
  CONSTRAINT "AdminGlobalSummaryRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdminGlobalSummaryRun_actorAccountId_fkey" FOREIGN KEY ("actorAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AdminGlobalSummaryRun_eventKey_key" ON "AdminGlobalSummaryRun"("eventKey");
CREATE INDEX "AdminGlobalSummaryRun_startedAt_idx" ON "AdminGlobalSummaryRun"("startedAt");
