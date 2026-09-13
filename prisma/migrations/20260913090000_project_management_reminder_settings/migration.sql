CREATE TYPE "ProjectManagementReminderKind" AS ENUM ('MILESTONE_DUE', 'MILESTONE_OVERDUE', 'TASK_ACTIVATION_OVERDUE', 'TASK_APPROVAL_PENDING');

CREATE TABLE "ProjectManagementReminderSetting" (
  "id" TEXT NOT NULL,
  "kind" "ProjectManagementReminderKind" NOT NULL,
  "timeOfDay" VARCHAR(5) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdByAccountId" TEXT NOT NULL,
  "updatedByAccountId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) WITH TIME ZONE NOT NULL,
  CONSTRAINT "ProjectManagementReminderSetting_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectManagementReminderSetting_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ProjectManagementReminderSetting_updatedByAccountId_fkey" FOREIGN KEY ("updatedByAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProjectManagementReminderSetting_kind_timeOfDay_key" ON "ProjectManagementReminderSetting"("kind", "timeOfDay");
CREATE INDEX "ProjectManagementReminderSetting_kind_enabled_timeOfDay_idx" ON "ProjectManagementReminderSetting"("kind", "enabled", "timeOfDay");
