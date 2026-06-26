-- 预算池改为车组+技术组配对；旧 scope 数据需重新导入
TRUNCATE TABLE "ProcurementBudgetPool";

DROP INDEX IF EXISTS "ProcurementBudgetPool_scope_scopeName_period_key";

ALTER TABLE "ProcurementBudgetPool" ADD COLUMN "team" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ProcurementBudgetPool" ADD COLUMN "techGroup" TEXT NOT NULL DEFAULT '';

ALTER TABLE "ProcurementBudgetPool" DROP COLUMN "scope";
ALTER TABLE "ProcurementBudgetPool" DROP COLUMN "scopeName";

DROP TYPE IF EXISTS "BudgetPoolScope";

ALTER TABLE "ProcurementBudgetPool" ALTER COLUMN "team" DROP DEFAULT;
ALTER TABLE "ProcurementBudgetPool" ALTER COLUMN "techGroup" DROP DEFAULT;

CREATE UNIQUE INDEX "ProcurementBudgetPool_team_techGroup_period_key" ON "ProcurementBudgetPool"("team", "techGroup", "period");
