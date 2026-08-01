-- Keep the historical reimbursement approver stable when Feishu rotates an
-- account's openId. Existing openId columns remain as immutable snapshots for
-- compatibility with old exports and callbacks.
ALTER TABLE "PurchaseOrder"
  ADD COLUMN "teamApproverAccountId" TEXT,
  ADD COLUMN "techGroupApproverAccountId" TEXT;

UPDATE "PurchaseOrder" orders
SET "teamApproverAccountId" = users."accountId"
FROM "User" users
WHERE orders."teamApproverOpenId" = users."openId"
  AND orders."teamApproverAccountId" IS NULL;

UPDATE "PurchaseOrder" orders
SET "techGroupApproverAccountId" = users."accountId"
FROM "User" users
WHERE orders."techGroupApproverOpenId" = users."openId"
  AND orders."techGroupApproverAccountId" IS NULL;

CREATE INDEX "PurchaseOrder_teamApproverAccountId_idx"
  ON "PurchaseOrder"("teamApproverAccountId");
CREATE INDEX "PurchaseOrder_techGroupApproverAccountId_idx"
  ON "PurchaseOrder"("techGroupApproverAccountId");

ALTER TABLE "PurchaseOrder"
  ADD CONSTRAINT "PurchaseOrder_teamApproverAccountId_fkey"
  FOREIGN KEY ("teamApproverAccountId") REFERENCES "Account"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PurchaseOrder_techGroupApproverAccountId_fkey"
  FOREIGN KEY ("techGroupApproverAccountId") REFERENCES "Account"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
