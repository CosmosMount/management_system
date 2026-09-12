ALTER TYPE "ProjectManagementReminderKind" ADD VALUE 'PERSONAL_SUMMARY';
CREATE TABLE "PersonalSummaryRun" (
  "id" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "actorAccountId" TEXT,
  "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMPTZ(6),
  "recipientCount" INTEGER NOT NULL DEFAULT 0,
  "errorMessage" TEXT,
  CONSTRAINT "PersonalSummaryRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PersonalSummaryRun_eventKey_key" ON "PersonalSummaryRun"("eventKey");
CREATE INDEX "PersonalSummaryRun_startedAt_idx" ON "PersonalSummaryRun"("startedAt");
CREATE TABLE "PersonalSummary" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "markdown" TEXT NOT NULL,
  "requiresApprovalAdministrator" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "PersonalSummary_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PersonalSummary_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PersonalSummaryRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PersonalSummary_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PersonalSummary_runId_accountId_key" ON "PersonalSummary"("runId", "accountId");
CREATE INDEX "PersonalSummary_accountId_idx" ON "PersonalSummary"("accountId");
