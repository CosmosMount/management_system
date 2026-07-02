-- CreateTable
CREATE TABLE "ProcurementFeishuCard" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "openId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "botKind" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementFeishuCard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProcurementFeishuCard_orderId_idx" ON "ProcurementFeishuCard"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementFeishuCard_orderId_openId_key" ON "ProcurementFeishuCard"("orderId", "openId");
