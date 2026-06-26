-- CreateEnum
CREATE TYPE "BudgetPoolScope" AS ENUM ('TEAM', 'TECH_GROUP');

-- CreateTable
CREATE TABLE "ProcurementBudgetPool" (
    "id" TEXT NOT NULL,
    "scope" "BudgetPoolScope" NOT NULL,
    "scopeName" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "budgetAmount" DOUBLE PRECISION NOT NULL,
    "lastAlertThreshold" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementBudgetPool_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementBudgetPool_scope_scopeName_period_key" ON "ProcurementBudgetPool"("scope", "scopeName", "period");
