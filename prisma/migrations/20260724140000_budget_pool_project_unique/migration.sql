-- 预算池按项目分行：唯一键改为 项目+车组+技术组+周期
DROP INDEX IF EXISTS "ProcurementBudgetPool_team_techGroup_period_key";

CREATE UNIQUE INDEX "ProcurementBudgetPool_description_team_techGroup_period_key"
  ON "ProcurementBudgetPool"("description", "team", "techGroup", "period");
