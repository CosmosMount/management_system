-- AlterTable
ALTER TABLE "ProcurementFeishuCard" ADD COLUMN "cardStage" TEXT NOT NULL DEFAULT '';

-- Backfill legacy rows: infer the most likely stage when cards were sent
UPDATE "ProcurementFeishuCard" p
SET "cardStage" = CASE
  WHEN o.status = 'PENDING_APPLICANT_CONFIRM' THEN 'PENDING_APPLICANT_CONFIRM'
  WHEN o.status = 'TEACHER_REVIEW' THEN 'TEACHER_REVIEW'
  ELSE 'MANAGEMENT_REVIEW'
END
FROM "PurchaseOrder" o
WHERE p."orderId" = o.id AND p."cardStage" = '';
