-- Keep one database-level pending lock per stage for records created before
-- pendingKey existed. If duplicate pending records already exist, the newest
-- one becomes the active lock and older rows keep their historical keys.
UPDATE "ProjectDdlChangeRequest" current_request
SET "pendingKey" = 'PENDING'
WHERE current_request."status" = 'PENDING'
  AND NOT EXISTS (
    SELECT 1
    FROM "ProjectDdlChangeRequest" newer_request
    WHERE newer_request."stageId" = current_request."stageId"
      AND newer_request."status" = 'PENDING'
      AND (
        newer_request."createdAt" > current_request."createdAt"
        OR (
          newer_request."createdAt" = current_request."createdAt"
          AND newer_request."id" > current_request."id"
        )
      )
  );
