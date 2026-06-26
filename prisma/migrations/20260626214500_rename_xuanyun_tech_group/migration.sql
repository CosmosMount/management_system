-- Rename the tech group display/value from "宣运技术组" to "宣运".
-- Deduplicate tables with unique constraints before updating the string value.

DELETE FROM "UserRole" old_role
USING "UserRole" new_role
WHERE old_role."openId" = new_role."openId"
  AND old_role."role" = new_role."role"
  AND old_role."team" = new_role."team"
  AND old_role."techGroup" = '宣运技术组'
  AND new_role."techGroup" = '宣运';

UPDATE "UserRole"
SET "techGroup" = '宣运'
WHERE "techGroup" = '宣运技术组';

DELETE FROM "TaskTechGroup" old_group
USING "TaskTechGroup" new_group
WHERE old_group."taskId" = new_group."taskId"
  AND old_group."techGroup" = '宣运技术组'
  AND new_group."techGroup" = '宣运';

UPDATE "TaskTechGroup"
SET "techGroup" = '宣运'
WHERE "techGroup" = '宣运技术组';

UPDATE "PurchaseOrder"
SET "techGroup" = '宣运'
WHERE "techGroup" = '宣运技术组';

UPDATE "Project"
SET "techGroup" = '宣运'
WHERE "techGroup" = '宣运技术组';

UPDATE "Task"
SET "techGroup" = '宣运'
WHERE "techGroup" = '宣运技术组';

UPDATE "TaskCreationRequest"
SET "draftPayload" = replace("draftPayload", '宣运技术组', '宣运')
WHERE "draftPayload" LIKE '%宣运技术组%';
