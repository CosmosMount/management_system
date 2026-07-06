-- CreateEnum
CREATE TYPE "ProgressFollowPreferenceState" AS ENUM ('FOLLOWING', 'MUTED');

-- CreateTable
CREATE TABLE "ProjectFollowPreference" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "openId" TEXT NOT NULL,
    "state" "ProgressFollowPreferenceState" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectFollowPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskFollowPreference" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "openId" TEXT NOT NULL,
    "state" "ProgressFollowPreferenceState" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskFollowPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectFollowPreference_projectId_openId_key" ON "ProjectFollowPreference"("projectId", "openId");

-- CreateIndex
CREATE INDEX "ProjectFollowPreference_openId_state_idx" ON "ProjectFollowPreference"("openId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "TaskFollowPreference_taskId_openId_key" ON "TaskFollowPreference"("taskId", "openId");

-- CreateIndex
CREATE INDEX "TaskFollowPreference_openId_state_idx" ON "TaskFollowPreference"("openId", "state");

-- AddForeignKey
ALTER TABLE "ProjectFollowPreference" ADD CONSTRAINT "ProjectFollowPreference_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskFollowPreference" ADD CONSTRAINT "TaskFollowPreference_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
