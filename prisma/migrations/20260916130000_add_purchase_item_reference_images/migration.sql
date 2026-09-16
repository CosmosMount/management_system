ALTER TABLE "PurchaseItem"
ADD COLUMN "referenceImagePaths" TEXT NOT NULL DEFAULT '[]';

UPDATE "PurchaseItem"
SET "referenceImagePaths" = json_build_array("referenceImagePath")::text
WHERE "referenceImagePath" IS NOT NULL;
