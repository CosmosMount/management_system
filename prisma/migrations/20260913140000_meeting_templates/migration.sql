BEGIN;

CREATE TABLE "MeetingTemplate" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500) NOT NULL DEFAULT '',
    "topic" VARCHAR(200) NOT NULL,
    "minutes" TEXT NOT NULL DEFAULT '',
    "timelineDisplay" JSONB NOT NULL DEFAULT '{"projectIds":[],"taskIds":[]}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    CONSTRAINT "MeetingTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MeetingTemplateParticipant" (
    "templateId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    CONSTRAINT "MeetingTemplateParticipant_pkey" PRIMARY KEY ("templateId", "personId")
);

CREATE INDEX "MeetingTemplate_deletedAt_updatedAt_id_idx" ON "MeetingTemplate"("deletedAt", "updatedAt", "id");
CREATE INDEX "MeetingTemplate_createdByAccountId_idx" ON "MeetingTemplate"("createdByAccountId");
CREATE INDEX "MeetingTemplateParticipant_personId_idx" ON "MeetingTemplateParticipant"("personId");
ALTER TABLE "MeetingTemplate" ADD CONSTRAINT "MeetingTemplate_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MeetingTemplateParticipant" ADD CONSTRAINT "MeetingTemplateParticipant_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MeetingTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MeetingTemplateParticipant" ADD CONSTRAINT "MeetingTemplateParticipant_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
